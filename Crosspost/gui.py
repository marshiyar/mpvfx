import os
import argparse
import threading
import queue
from tkinter import filedialog
import customtkinter as ctk

# Modular backend functions imported from their respective service files.
# UploadYoutube handles Google OAuth2 authorization, chunked resumable upload, and custom thumbnails.
from UploadYoutube import authenticate_youtube, upload_video, set_video_thumbnail

# UploadFacebook handles Meta Graph API POST requests and multipart form data transmission.
from UploadFacebook import upload_facebook_video

# Visual configuration: Set dark interface theme with blue accent buttons
ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("blue")


class VideoCrossPosterApp(ctk.CTk):
    """
    Main Application Window:
    Constructs the GUI layout, gathers metadata inputs, and triggers background
    upload threads to deliver media to YouTube and Facebook simultaneously.
    """
    def __init__(self, video_path=None):
        super().__init__()
        self.ui_updates = queue.Queue()
        self.upload_in_progress = False
        self.protocol("WM_DELETE_WINDOW", self.handle_close)
        self.after(50, self.drain_ui_updates)

        # --- WINDOW GEOMETRY CONFIGURATION ---
        # Fixed resolution (620x780) prevents UI elements from resizing awkwardly or overlapping.
        self.title("Video Cross-Poster")
        self.geometry("620x780")
        self.resizable(False, False)

        # --- APP HEADER ---
        # Prominent visual anchor at the top of the interface
        self.header_label = ctk.CTkLabel(
            self,
            text="Multi-Platform Video Publisher",
            font=ctk.CTkFont(size=20, weight="bold")
        )
        self.header_label.pack(pady=(20, 10))

        # --- SECTION 1: VIDEO SOURCE FILE SELECTION ---
        # Encapsulates file path entry box and system explorer file-picker button.
        self.file_frame = ctk.CTkFrame(self)
        self.file_frame.pack(padx=30, pady=6, fill="x")

        self.file_path_entry = ctk.CTkEntry(
            self.file_frame,
            placeholder_text="No video selected...",
            width=420
        )
        self.file_path_entry.pack(side="left", padx=(10, 10), pady=10)
        if video_path:
            self.file_path_entry.insert(0, video_path)

        self.browse_btn = ctk.CTkButton(
            self.file_frame,
            text="Browse Video",
            width=100,
            command=self.browse_video
        )
        self.browse_btn.pack(side="right", padx=(0, 10), pady=10)

        # --- SECTION 2: OPTIONAL THUMBNAIL COVER SELECTION ---
        # Allows supplying a custom cover picture for platforms that support it (YouTube).
        self.thumb_frame = ctk.CTkFrame(self)
        self.thumb_frame.pack(padx=30, pady=6, fill="x")

        self.thumb_path_entry = ctk.CTkEntry(
            self.thumb_frame,
            placeholder_text="Optional: Select thumbnail image...",
            width=420
        )
        self.thumb_path_entry.pack(side="left", padx=(10, 10), pady=10)

        self.thumb_browse_btn = ctk.CTkButton(
            self.thumb_frame,
            text="Browse Image",
            width=100,
            command=self.browse_thumbnail
        )
        self.thumb_browse_btn.pack(side="right", padx=(0, 10), pady=10)

        # --- SECTION 3: METADATA DESCRIPTORS (Title, Description, Tags) ---
        # Form fields for platform post details (replaces manual console prompts).
        self.meta_frame = ctk.CTkFrame(self)
        self.meta_frame.pack(padx=30, pady=6, fill="x")

        # Title Field (single line input)
        self.title_label = ctk.CTkLabel(self.meta_frame, text="Video Title:")
        self.title_label.pack(anchor="w", padx=15, pady=(8, 0))
        self.title_entry = ctk.CTkEntry(self.meta_frame, placeholder_text="Enter video title...")
        self.title_entry.pack(fill="x", padx=15, pady=(2, 8))

        # Description Field (multi-line expandable textbox)
        self.desc_label = ctk.CTkLabel(self.meta_frame, text="Description:")
        self.desc_label.pack(anchor="w", padx=15, pady=(4, 0))
        self.desc_textbox = ctk.CTkTextbox(self.meta_frame, height=90)
        self.desc_textbox.pack(fill="x", padx=15, pady=(2, 8))

        # Tags Field (comma-delimited keywords used for search indexing)
        self.tags_label = ctk.CTkLabel(self.meta_frame, text="Tags (comma-separated):")
        self.tags_label.pack(anchor="w", padx=15, pady=(4, 0))
        self.tags_entry = ctk.CTkEntry(self.meta_frame, placeholder_text="tech, coding, automation")
        self.tags_entry.pack(fill="x", padx=15, pady=(2, 12))

        # --- SECTION 4: PLATFORM TARGETING & VISIBILITY CONTROLS ---
        # Checkboxes decide which APIs run; dropdown configures video audience permissions.
        self.opts_frame = ctk.CTkFrame(self)
        self.opts_frame.pack(padx=30, pady=6, fill="x")

        self.platform_label = ctk.CTkLabel(
            self.opts_frame,
            text="Publish To:",
            font=ctk.CTkFont(weight="bold")
        )
        self.platform_label.pack(anchor="w", padx=15, pady=(8, 4))

        # Each destination requires an explicit selection.
        self.chk_youtube = ctk.CTkCheckBox(self.opts_frame, text="YouTube")
        self.chk_youtube.deselect()
        self.chk_youtube.pack(side="left", padx=15, pady=(0, 12))

        # Facebook Page checkbox (Targets your authenticated Mpvfx Page)
        self.chk_facebook = ctk.CTkCheckBox(self.opts_frame, text="Facebook (Mpvfx)")
        self.chk_facebook.deselect()
        self.chk_facebook.pack(side="left", padx=15, pady=(0, 12))

        # Privacy State Dropdown (Defaults to 'unlisted' to allow review before going public)
        self.privacy_dropdown = ctk.CTkComboBox(
            self.opts_frame,
            values=["unlisted", "private", "public"],
            width=130
        )
        self.privacy_dropdown.set("unlisted")
        self.privacy_dropdown.pack(side="right", padx=15, pady=(0, 12))

        # --- SECTION 5: LIVE PROGRESS FEEDBACK ---
        # Visual loading bar (0.0 to 1.0) and descriptive text for network feedback.
        self.progress_bar = ctk.CTkProgressBar(self, width=540)
        self.progress_bar.set(0)
        self.progress_bar.pack(pady=(15, 5))

        self.status_label = ctk.CTkLabel(self, text="Ready", text_color="gray")
        self.status_label.pack(pady=(0, 8))

        # --- SECTION 6: EXECUTION TRIGGER ---
        # Action button that initiates validation and fires the background thread.
        self.upload_btn = ctk.CTkButton(
            self,
            text="Start Cross-Posting",
            height=45,
            font=ctk.CTkFont(size=15, weight="bold"),
            command=self.start_upload_thread
        )
        self.upload_btn.pack(padx=30, pady=(5, 15), fill="x")

    def post_ui(self, text=None, text_color=None, progress=None, button=None):
        self.ui_updates.put((text, text_color, progress, button))

    def drain_ui_updates(self):
        try:
            while True:
                text, text_color, progress, button = self.ui_updates.get_nowait()
                if text is not None:
                    self.status_label.configure(text=text, text_color=text_color or "gray")
                if progress is not None:
                    self.progress_bar.set(progress)
                if button is not None:
                    self.upload_btn.configure(state=button)
                    self.upload_in_progress = button == "disabled"
        except queue.Empty:
            pass
        self.after(50, self.drain_ui_updates)

    def handle_close(self):
        if self.upload_in_progress:
            self.status_label.configure(
                text="Publishing is in progress. Keep this window open until it finishes.",
                text_color="red",
            )
            return
        self.destroy()

    def browse_video(self):
        """Launches the native OS file picker to locate an MP4, MOV, or MKV video."""
        file_selected = filedialog.askopenfilename(
            title="Select Video",
            filetypes=[("Video Files", "*.mp4 *.mov *.mkv"), ("All Files", "*.*")]
        )
        if file_selected:
            self.file_path_entry.delete(0, "end")
            self.file_path_entry.insert(0, file_selected)

    def browse_thumbnail(self):
        """Launches the native OS file picker to pick an optional thumbnail preview image."""
        file_selected = filedialog.askopenfilename(
            title="Select Thumbnail Image",
            filetypes=[("Image Files", "*.png *.jpg *.jpeg"), ("All Files", "*.*")]
        )
        if file_selected:
            self.thumb_path_entry.delete(0, "end")
            self.thumb_path_entry.insert(0, file_selected)

    def start_upload_thread(self):
        """Capture form values on the UI thread, then run network work in the background."""
        if self.upload_in_progress:
            return
        video_path = self.file_path_entry.get().strip()
        thumb_path = self.thumb_path_entry.get().strip()
        title = self.title_entry.get().strip() or "Untitled Video"
        description = self.desc_textbox.get("1.0", "end-1c").strip()
        tags = [t.strip() for t in self.tags_entry.get().split(",") if t.strip()]
        privacy = self.privacy_dropdown.get()
        post_to_yt = bool(self.chk_youtube.get())
        post_to_fb = bool(self.chk_facebook.get())
        if not video_path or not os.path.isfile(video_path):
            self.status_label.configure(text="Select an existing video file first.", text_color="red")
            return
        if not post_to_yt and not post_to_fb:
            self.status_label.configure(text="Select at least one platform to publish to.", text_color="red")
            return
        self.upload_in_progress = True
        self.upload_btn.configure(state="disabled")
        self.progress_bar.set(0)
        threading.Thread(
            target=self.run_upload,
            args=(video_path, thumb_path, title, description, tags, privacy, post_to_yt, post_to_fb),
            daemon=True,
        ).start()

    def run_upload(self, video_path, thumb_path, title, description, tags, privacy, post_to_yt, post_to_fb):
        """Publish selected targets while posting all widget updates to the UI thread."""
        results = []

        try:
            # ==========================================
            # 1. YOUTUBE UPLOAD PIPELINE
            # ==========================================
            if post_to_yt:
                self.post_ui(text="YouTube: Authenticating...", text_color="#1f6aa5")
                youtube_service = authenticate_youtube()

                # Progress callback scaled to 0%–50% if Facebook follows, or 0%–100% if solo
                def update_yt_progress(percent):
                    factor = 0.5 if post_to_fb else 1.0
                    self.post_ui(progress=percent * factor)
                    self.post_ui(
                        text=f"YouTube Uploading: {int(percent * 100)}%",
                        text_color="#1f6aa5"
                    )

                # Send chunked upload to YouTube v3 API
                yt_res = upload_video(
                    youtube=youtube_service,
                    file_path=video_path,
                    title=title,
                    description=description,
                    tags=tags,
                    privacy_status=privacy,
                    progress_callback=update_yt_progress
                )
                yt_id = yt_res.get("id")
                results.append(f"YT: {yt_id}")

                # Attach custom thumbnail image if one was provided
                if thumb_path and os.path.exists(thumb_path):
                    self.post_ui(text="YouTube: Setting thumbnail...", text_color="#1f6aa5")
                    try:
                        set_video_thumbnail(youtube_service, yt_id, thumb_path)
                    except Exception as t_err:
                        print(f"Thumbnail skipped (account may need phone verification): {t_err}")

            # ==========================================
            # 2. FACEBOOK PAGE UPLOAD PIPELINE
            # ==========================================
            if post_to_fb:
                self.post_ui(text="Facebook: Uploading...", text_color="#1f6aa5")

                # Progress callback scaled to 50%–100% if YouTube ran, or 0%–100% if solo
                def update_fb_progress(percent):
                    base = 0.5 if post_to_yt else 0.0
                    factor = 0.5 if post_to_yt else 1.0
                    self.post_ui(progress=base + (percent * factor))
                    self.post_ui(
                        text=f"Facebook Uploading: {int(percent * 100)}%",
                        text_color="#1f6aa5"
                    )

                # Post multipart payload to Meta Graph API
                fb_id = upload_facebook_video(
                    file_path=video_path,
                    title=title,
                    description=description,
                    progress_callback=update_fb_progress
                )
                results.append(f"FB: {fb_id}")

            # Complete progress and display success message with returned Video IDs
            self.post_ui(progress=1.0)
            self.post_ui(
                text=f"Done! {', '.join(results)}",
                text_color="green"
            )

        except Exception as e:
            # Catch API errors or missing credentials without crashing the application
            self.post_ui(text=f"Upload Failed: {e}" + (f". Already published: {', '.join(results)}" if results else ""), text_color="red")
        finally:
            # Re-enable the upload button once all work is finished
            self.post_ui(button="normal")


# Application entry point: Only executes when running this script directly
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--video")
    parser.add_argument("--ready-file")
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    if args.preflight:
        print("mpvfx-publisher-ready", flush=True)
        raise SystemExit(0)
    app = VideoCrossPosterApp(args.video)
    if args.ready_file:
        def signal_ready():
            with open(args.ready_file, "x", encoding="utf-8") as marker:
                marker.write("ready")
        app.after_idle(signal_ready)
    app.mainloop()
