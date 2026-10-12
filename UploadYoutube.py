import os
import google_auth_oauthlib.flow
import googleapiclient.discovery
import googleapiclient.errors
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.http import MediaFileUpload
import google.auth.exceptions

# YouTube upload scope
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]

def authenticate_youtube():
    """Authenticates the user and caches the token locally."""
    creds = None
    
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except google.auth.exceptions.RefreshError:
                print("Token expired or revoked. Re-authenticating via browser...")
                os.remove("token.json")
                creds = None

        if not creds:
            flow = google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file(
                "client_secrets.json", SCOPES
            )
            creds = flow.run_local_server(port=8080)
            
        with open("token.json", "w") as token:
            token.write(creds.to_json())

    return googleapiclient.discovery.build("youtube", "v3", credentials=creds)

def get_user_input():
    print("\n--- Video Metadata Configuration ---") # User input video info for youtube  
    
    # Video file path
    while True:
        video_path = input("Enter video file name or path [default: test.mp4]: ").strip()
        if not video_path:
            video_path = "test.mp4"
        if os.path.exists(video_path):
            break
        print(f"Error: File '{video_path}' does not exist. Try again.")

    # Title
    title = input("Enter video title [default: API Upload Test]: ").strip()
    if not title:
        title = "API Upload Test"

    # Description
    desc = input("Enter description (add #Shorts here if vertical video): ").strip()

    # Tags
    raw_tags = input("Enter tags separated by commas (e.g., test, python, dev): ").strip()
    tags = [t.strip() for t in raw_tags.split(",") if t.strip()] if raw_tags else ["test", "api"]
    
    # Privacy status
    print("\nPrivacy Status: [1] unlisted (recommended for tests), [2] private, [3] public")
    choice = input("Select choice [1-3, default: 1]: ").strip()
    privacy_map = {"1": "unlisted", "2": "private", "3": "public"}
    privacy_status = privacy_map.get(choice, "unlisted")

    return video_path, title, desc, tags, privacy_status

def upload_video(youtube, file_path, title, description, tags, privacy_status, progress_callback=None): 
    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": "22"  # Automatically uses People & Blogs
        },
        "status": {
            "privacyStatus": privacy_status # this is for public unlisted or private video upload to youtube
        }
    }

    media = MediaFileUpload(file_path, chunksize=1024 * 1024, resumable=True)

    request = youtube.videos().insert(
        part="snippet,status",
        body=body,
        media_body=media
    )
    
    

    print(f"\nUploading '{file_path}' ({privacy_status})...")
    response = None

    try:
        while response is None:
            status, response = request.next_chunk()
            if status:
                percent = status.progress()
                print(f"Upload Progress: {int(percent * 100)}%")
                if progress_callback:
                    progress_callback(percent)

        print("\n--- UPLOAD SUCCESSFUL ---")
        print(f"Video ID: {response['id']}")
        print(f"Watch Link: https://youtu.be/{response['id']}")
        return response

    except googleapiclient.errors.HttpError as error:
        print("\n--- UPLOAD FAILED ---")
        print(f"HTTP Error Code: {error.resp.status}")
        print(f"Reason: {error.content.decode('utf-8')}")
        raise error

def set_video_thumbnail(youtube, video_id, image_path):
    """Sets a custom thumbnail for an existing uploaded video."""
    media = MediaFileUpload(image_path, mimetype="image/jpeg", resumable=False)
    
    request = youtube.thumbnails().set(
        videoId=video_id,
        media_body=media
    )
    response = request.execute()
    return response

if __name__ == "__main__":
    if not os.path.exists("client_secrets.json"):
        print("[ERROR] 'client_secrets.json' was not found.")
    else:
        file_path, title, desc, tags, privacy_status = get_user_input()
        youtube_service = authenticate_youtube()
        upload_video(youtube_service, file_path, title, desc, tags, privacy_status)