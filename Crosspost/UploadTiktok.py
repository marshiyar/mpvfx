import os
import json
import base64
import hashlib
import secrets
import webbrowser
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests

# --- DEVELOPER APP CONFIGURATION ---
TIKTOK_CLIENT_KEY = "Your Own" #replace with your own TikTok Client Key from developers.tiktokglobalshop.com
TIKTOK_CLIENT_SECRET = "Your Own" #replace with your own TikTok Client Secret from developers.tiktokglobalshop.com
REDIRECT_URI = "http://localhost:8080/callback/"
TOKEN_FILE = "tiktok_token.json"

_auth_code = None


class _TikTokOAuthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global _auth_code
        parsed = urllib.parse.urlparse(self.path)

        # Ignore browser background favicon requests
        if parsed.path == "/favicon.ico":
            self.send_response(404)
            self.end_headers()
            return

        query = urllib.parse.parse_qs(parsed.query)
        if "code" in query and _auth_code is None:
            _auth_code = query["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<h1>TikTok Login Successful!</h1>"
                b"<p>You can close this tab and return to VS Code.</p>"
            )
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<h1>Callback Received</h1>")

    def log_message(self, format, *args):
        return


def _generate_pkce():
    # 64-char alphanumeric verifier per RFC 7636
    chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    verifier = "".join(secrets.choice(chars) for _ in range(64))

    sha256_hash = hashlib.sha256(verifier.encode("ascii")).digest()

    # TikTok requires hexadecimal SHA-256 encoding
    challenge = hashlib.sha256(
        verifier.encode("ascii")
    ).hexdigest()

    return verifier, challenge


def authenticate_tiktok():
    global _auth_code
    _auth_code = None

    code_verifier, code_challenge = _generate_pkce()
    scopes = "user.info.basic,video.upload,video.publish"

    params = {
        "client_key": TIKTOK_CLIENT_KEY,
        "response_type": "code",
        "scope": scopes,
        "redirect_uri": REDIRECT_URI,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256"
    }

    auth_url = f"https://www.tiktok.com/v2/auth/authorize/?{urllib.parse.urlencode(params)}"

    print("Opening browser for TikTok login...")
    webbrowser.open(auth_url)

    server = HTTPServer(("localhost", 8080), _TikTokOAuthHandler)
    server.timeout = 1

    try:
        while _auth_code is None:
            server.handle_request()

    except KeyboardInterrupt:
        print("\nAuthentication cancelled by user.")
        server.server_close()
        return None

    finally:
        server.server_close()

    print(f"Captured Auth Code: {_auth_code[:10]}...")

    # Exchange temporary auth code and verifier for Access Token
    token_url = "https://open.tiktokapis.com/v2/oauth/token/"

    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache"
    }

    payload = {
        "client_key": TIKTOK_CLIENT_KEY,
        "client_secret": TIKTOK_CLIENT_SECRET,
        "code": _auth_code,
        "grant_type": "authorization_code",
        "redirect_uri": REDIRECT_URI,
        "code_verifier": code_verifier
    }

    resp = requests.post(
        token_url,
        headers=headers,
        data=payload
    ).json()

    # TikTok returns the token fields at the top level
    token_data = resp.get("data", resp)

    if not token_data or "access_token" not in token_data:
        raise ValueError(f"TikTok authentication failed: {resp}")

    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump(token_data, f, indent=2)

    print("Connected to TikTok successfully.")
    return token_data


def get_tiktok_credentials():
    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)

                if data.get("access_token"):
                    return data

        except Exception:
            pass

    return authenticate_tiktok()


def upload_tiktok_video(file_path, title, progress_callback=None):
    creds = get_tiktok_credentials()
    token = creds["access_token"]
    file_size = os.path.getsize(file_path)

    init_url = "https://open.tiktokapis.com/v2/post/publish/video/init/"

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=UTF-8"
    }

    payload = {
        "post_info": {
            "title": title,
            "privacy_level": "SELF_ONLY",
            "disable_duet": False,
            "disable_comment": False,
            "disable_stitch": False
        },
        "source_info": {
            "source": "FILE_UPLOAD",
            "video_size": file_size,
            "chunk_size": file_size,
            "total_chunk_count": 1
        }
    }

    if progress_callback:
        progress_callback(0.2)

    init_res = requests.post(
        init_url,
        headers=headers,
        json=payload
    ).json()

    if init_res.get("error", {}).get("code") != "ok":
        if os.path.exists(TOKEN_FILE):
            os.remove(TOKEN_FILE)

        raise RuntimeError(
            f"TikTok Init Error: {init_res.get('error')}"
        )

    upload_url = init_res["data"]["upload_url"]
    publish_id = init_res["data"]["publish_id"]

    with open(file_path, "rb") as video_file:
        upload_headers = {
            "Content-Range": f"bytes 0-{file_size - 1}/{file_size}",
            "Content-Type": "video/mp4"
        }

        put_res = requests.put(
            upload_url,
            headers=upload_headers,
            data=video_file
        )

        if put_res.status_code not in (200, 201):
            raise RuntimeError(
                f"Video upload failed with code {put_res.status_code}"
            )

    if progress_callback:
        progress_callback(1.0)

    return {
        "publish_id": publish_id,
        "status": "Uploaded"
    }


if __name__ == "__main__":
    print("Testing TikTok Login flow...")
    creds = authenticate_tiktok()
    print("Success! Token captured.")
