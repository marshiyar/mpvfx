import os
import json
import requests

CREDENTIALS_FILE = os.path.join(os.environ.get("MPVFX_CROSSPOST_CONFIG_DIR", "."), "facebook_credentials.json")

def load_facebook_credentials():
    """Loads Page ID and Page Access Token from the local config file."""
    if not os.path.exists(CREDENTIALS_FILE):
        raise FileNotFoundError(
            f"Missing '{CREDENTIALS_FILE}'. Make sure it exists in the project root."
        )
    with open(CREDENTIALS_FILE, "r") as f:
        return json.load(f)

def upload_facebook_video(file_path, title, description, progress_callback=None):
    """
    Publishes a video to your Facebook Page using the Graph API.
    """
    creds = load_facebook_credentials()
    page_id = creds.get("page_id")
    access_token = creds.get("access_token")

    if not page_id or not access_token:
        raise ValueError("Missing 'page_id' or 'access_token' in facebook_credentials.json")

    url = f"https://graph.facebook.com/v20.0/{page_id}/videos"

    payload = {
        "access_token": access_token,
        "title": title,
        "description": description
    }

    if progress_callback:
        progress_callback(0.25)

    with open(file_path, "rb") as video_file:
        files = {
            "source": (os.path.basename(file_path), video_file, "video/mp4")
        }
        response = requests.post(url, data=payload, files=files)

    if progress_callback:
        progress_callback(0.85)

    result = response.json()

    if "error" in result:
        err_msg = result["error"].get("message", "Unknown error")
        raise RuntimeError(f"Meta Graph API Error: {err_msg}")

    if progress_callback:
        progress_callback(1.0)

    return result.get("id")

if __name__ == "__main__":
    # Test script directly before connecting to the GUI
    test_video = "test.mp4"  # Change to your local 30s video path

    if os.path.exists(test_video):
        print(f"Uploading '{test_video}' to Facebook Page...")
        try:
            vid_id = upload_facebook_video(
                file_path=test_video,
                title="Automated Pipeline Test",
                description="Testing Meta Graph API upload from local Python backend."
            )
            print(f"Success! Facebook Video ID: {vid_id}")
            print(f"Watch Link: https://www.facebook.com/{vid_id}")
        except Exception as e:
            print(f"Upload Failed: {e}")
    else:
        print(f"File '{test_video}' not found. Update the path in the test block.")
