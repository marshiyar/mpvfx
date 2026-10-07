import os
import json
import webbrowser
import requests
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# --- DEVELOPER APP CONFIGURATION ---
# Replace these two with your App ID and App Secret from developers.facebook.com
FB_APP_ID = "1801150857584943" # Test one for ours is 122306855234245757 dont plublish
FB_APP_SECRET = "6ba57a5163742dab2df9513c38afedb7" #Delete and  place YOUR APP SECRET DONT LEAbE CURRENT number

REDIRECT_URI = "http://localhost:8080/"
TOKEN_FILE = "facebook_token.json"
GRAPH_API_VERSION = "v26.0"

_auth_code = None


class _OAuthHandler(BaseHTTPRequestHandler):
    """Temporary local HTTP listener that captures the authorization code redirect."""
    def do_GET(self):
        global _auth_code
        query = parse_qs(urlparse(self.path).query)
        if "code" in query:
            _auth_code = query["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<h1>Facebook Login Successful!</h1>"
                b"<p>You can safely close this browser tab and return to the application.</p>"
            )
        else:
            self.send_response(400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<h1>Authentication Failed</h1><p>No authorization code received.</p>")

    def log_message(self, format, *args):
        return  # Suppress internal server output in console


def authenticate_facebook():
    """Spins up a browser dialog for user login and caches the resulting Page Access Token."""
    global _auth_code
    _auth_code = None

    scopes = "pages_show_list,pages_manage_posts,pages_read_engagement"
    auth_url = (
        f"https://www.facebook.com/{GRAPH_API_VERSION}/dialog/oauth"
        f"?client_id={FB_APP_ID}"
        f"&redirect_uri={REDIRECT_URI}"
        f"&scope={scopes}"
        f"&response_type=code"
    )

    print("Opening browser for Facebook login...")
    webbrowser.open(auth_url)

    server = HTTPServer(("localhost", 8080), _OAuthHandler)
    while _auth_code is None:
        server.handle_request()
    server.server_close()

    # 1. Exchange temporary auth code for a User Access Token
    token_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/oauth/access_token"
    token_resp = requests.get(token_url, params={
        "client_id": FB_APP_ID,
        "client_secret": FB_APP_SECRET,
        "redirect_uri": REDIRECT_URI,
        "code": _auth_code
    }).json()

    user_token = token_resp.get("access_token")
    if not user_token:
        raise ValueError(f"Facebook authentication failed: {token_resp}")

    # 2. Query the user's managed Pages to extract the Page Access Token
    accounts_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/me/accounts"
    accounts_resp = requests.get(accounts_url, params={"access_token": user_token}).json()

    pages = accounts_resp.get("data", [])
    if not pages:
        raise ValueError("No Facebook Pages found. Ensure the account manages at least one Page.")

    # Select the first page associated with the logged-in user
    primary_page = pages[0]
    token_data = {
        "page_id": primary_page["id"],
        "page_name": primary_page["name"],
        "access_token": primary_page["access_token"]
    }

    # Save to local cache so subsequent uploads don't re-prompt
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump(token_data, f, indent=2)

    print(f"Connected to Facebook Page: {token_data['page_name']} ({token_data['page_id']})")
    return token_data


def get_facebook_credentials():
    """Retrieves cached token if present, otherwise executes interactive browser login."""
    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("access_token") and data.get("page_id"):
                    return data
        except Exception:
            pass
    return authenticate_facebook()


def upload_facebook_video(file_path, title, description, progress_callback=None):
    """Uploads a local video to the authenticated Facebook Page."""
    creds = get_facebook_credentials()
    page_id = creds["page_id"]
    access_token = creds["access_token"]

    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/videos"
    payload = {
        "access_token": access_token,
        "title": title,
        "description": description
    }

    with open(file_path, "rb") as video_file:
        files = {"source": video_file}
        response = requests.post(url, data=payload, files=files)

    result = response.json()
    if "error" in result:
        # If the token has expired, purge cached file so the next attempt prompts login
        if os.path.exists(TOKEN_FILE):
            os.remove(TOKEN_FILE)
        raise RuntimeError(f"Facebook API Error: {result['error'].get('message')}")

    return result


if __name__ == "__main__":
    # Direct test trigger
    print("Testing Facebook Login flow...")
    creds = authenticate_facebook()
    print("Success! Captured Credentials:", creds)