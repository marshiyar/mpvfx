import os
import threading
from tkinter import filedialog
import customtkinter as ctk

# Modular backend functions imported from their respective service files.
from UploadYoutube import authenticate_youtube, upload_video, set_video_thumbnail
from UploadFacebook import upload_facebook_video
from UploadTiktok import upload_tiktok_video
# Visual configuration: Set dark interface theme with blue accent buttons
ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("blue")


class VideoCrossPosterApp(ctk.CTk):
    """
    Main Application Window:
    Constructs the GUI layout, gathers metadata inputs, and triggers background
    upload threads to deliver media to YouTube and Facebook simultaneously.
    """
    def __init__(self):
        super().__init__()

        # --- WINDOW GEOMETRY CONFIGURATION ---
        self.title("Video Cross-Poster")
        self.geometry("620x780")
        self.resizable(False, False)

        # --- APP HEADER ---
        self.header_label = ctk.CTkLabel(
            self, 
            text="Multi-Platform Video Publisher",
            font=ctk.CTkFont(size=20, weight="bold")
        )
        self.header_label.pack(pady=(20, 10))

        # --- SECTION 1: VIDEO SOURCE FILE SELECTION ---
        self.file_frame = ctk.CTkFrame(self)
        self.file_frame.pack(padx=30, pady=6, fill="x")

        self.file_path_entry = ctk.CTkEntry(
            self.file_frame, 
            placeholder_text="No video selected...", 
            width=420
        )
        self.file_path_entry.pack(side="left", padx=(10, 10), pady=10)

        self.browse_btn = ctk.CTkButton(
            self.file_frame, 
            text="Browse Video", 
            width=100, 
            command=self.browse_video
        )
        self.browse_btn.pack(side="right", padx=(0, 10), pady=10)

        # --- SECTION 2: OPTIONAL THUMBNAIL COVER SELECTION ---
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
        self.meta_frame = ctk.CTkFrame(self)
        self.meta_frame.pack(padx=30, pady=6, fill="x")

        # Title Field
        self.title_label = ctk.CTkLabel(self.meta_frame, text="Video Title:")
        self.title_label.pack(anchor="w", padx=15, pady=(8, 0))
        self.title_entry = ctk.CTkEntry(self.meta_frame, placeholder_text="Enter video title...")
        self.title_entry.pack(fill="x", padx=15, pady=(2, 8))

        # Description Field
        self.desc_label = ctk.CTkLabel(self.meta_frame, text="Description:")
        self.desc_label.pack(anchor="w", padx=15, pady=(4, 0))
        self.desc_textbox = ctk.CTkTextbox(self.meta_frame, height=90)
        self.desc_textbox.pack(fill="x", padx=15, pady=(2, 8))

        # Tags Field
        self.tags_label = ctk.CTkLabel(self.meta_frame, text="Tags (comma-separated):")
        self.tags_label.pack(anchor="w", padx=15, pady=(4, 0))
        self.tags_entry = ctk.CTkEntry(self.meta_frame, placeholder_text="tech, coding, automation")
        self.tags_entry.pack(fill="x", padx=15, pady=(2, 12))

        # --- SECTION 4: PLATFORM TARGETING & VISIBILITY CONTROLS ---
        self.opts_frame = ctk.CTkFrame(self)
        self.opts_frame.pack(padx=30, pady=6, fill="x")

        self.platform_label = ctk.CTkLabel(
            self.opts_frame, 
            text="Publish To:", 
            font=ctk.CTkFont(weight="bold")
        )
        self.platform_label.pack(anchor="w", padx=15, pady=(8, 4))

        # YouTube Checkbox
        self.chk_youtube = ctk.CTkCheckBox(self.opts_frame, text="YouTube")
        self.chk_youtube.select()
        self.chk_youtube.pack(side="left", padx=15, pady=(0, 12))

        # Facebook Page Checkbox
        self.chk_facebook = ctk.CTkCheckBox(self.opts_frame, text="Facebook (Mpvfx)")
        self.chk_facebook.select()
        self.chk_facebook.pack(side="left", padx=15, pady=(0, 12))
        # TikTok Checkbox
        self.chk_tiktok = ctk.CTkCheckBox(self.opts_frame, text="TikTok")
        self.chk_tiktok.select()
        self.chk_tiktok.pack(side="left", padx=15, pady=(0, 12))

        # Privacy State Dropdown
        self.privacy_dropdown = ctk.CTkComboBox(
            self.opts_frame, 
            values=["unlisted", "private", "public"],
            width=130
        )
        self.privacy_dropdown.set("unlisted")
        self.privacy_dropdown.pack(side="right", padx=15, pady=(0, 12))

        # --- SECTION 5: LIVE PROGRESS FEEDBACK ---
        self.progress_bar = ctk.CTkProgressBar(self, width=540)
        self.progress_bar.set(0)
        self.progress_bar.pack(pady=(15, 5))

        self.status_label = ctk.CTkLabel(self, text="Ready", text_color="gray")
        self.status_label.pack(pady=(0, 8))

        # --- SECTION 6: EXECUTION TRIGGER ---
        self.upload_btn = ctk.CTkButton(
            self, 
            text="Start Cross-Posting", 
            height=45, 
            font=ctk.CTkFont(size=15, weight="bold"),
            command=self.start_upload_thread
        )
        self.upload_btn.pack(padx=30, pady=(5, 15), fill="x")

    def browse_video(self):
        file_selected = filedialog.askopenfilename(
            title="Select Video",
            filetypes=[("Video Files", "*.mp4 *.mov *.mkv"), ("All Files", "*.*")]
        )
        if file_selected:
            self.file_path_entry.delete(0, "end")
            self.file_path_entry.insert(0, file_selected)

    def browse_thumbnail(self):
        file_selected = filedialog.askopenfilename(
            title="Select Thumbnail Image",
            filetypes=[("Image Files", "*.png *.jpg *.jpeg"), ("All Files", "*.*")]
        )
        if file_selected:
            self.thumb_path_entry.delete(0, "end")
            self.thumb_path_entry.insert(0, file_selected)

    def start_upload_thread(self):
        upload_thread = threading.Thread(target=self.run_upload, daemon=True)
        upload_thread.start()

    def run_upload(self):
        video_path = self.file_path_entry.get().strip()
        thumb_path = self.thumb_path_entry.get().strip()
        title = self.title_entry.get().strip() or "Untitled Video"
        description = self.desc_textbox.get("1.0", "end-1c").strip()
        tags = [t.strip() for t in self.tags_entry.get().split(",") if t.strip()]
        privacy = self.privacy_dropdown.get()

        post_to_yt = bool(self.chk_youtube.get())
        post_to_fb = bool(self.chk_facebook.get())
        post_to_tt = bool(self.chk_tiktok.get())

        if not video_path:
            self.status_label.configure(text="Please select a video file first.", text_color="red")
            return

        if not post_to_yt and not post_to_fb and not post_to_tt:
            self.status_label.configure(text="Select at least one platform to publish to.", text_color="red")
            return

        self.upload_btn.configure(state="disabled")
        self.progress_bar.set(0)

        results = []

        try:
            
            # 1. YOUTUBE UPLOAD PIPELINE
            
            if post_to_yt:
                self.status_label.configure(text="YouTube: Authenticating...", text_color="#1f6aa5")
                youtube_service = authenticate_youtube()

                def update_yt_progress(percent):
                    factor = 0.5 if post_to_fb else 1.0
                    self.progress_bar.set(percent * factor)
                    self.status_label.configure(
                        text=f"YouTube Uploading: {int(percent * 100)}%", 
                        text_color="#1f6aa5"
                    )

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

                if thumb_path and os.path.exists(thumb_path):
                    self.status_label.configure(text="YouTube: Setting thumbnail...", text_color="#1f6aa5")
                    try:
                        set_video_thumbnail(youtube_service, yt_id, thumb_path)
                    except Exception as t_err:
                        print(f"Thumbnail skipped (account may need phone verification): {t_err}")

            #
            # 2. FACEBOOK PAGE UPLOAD PIPELINE
            # 
            if post_to_fb:
                self.status_label.configure(text="Facebook: Uploading...", text_color="#1f6aa5")

                def update_fb_progress(percent):
                    base = 0.5 if post_to_yt else 0.0
                    factor = 0.5 if post_to_yt else 1.0
                    self.progress_bar.set(base + (percent * factor))
                    self.status_label.configure(
                        text=f"Facebook Uploading: {int(percent * 100)}%", 
                        text_color="#1f6aa5"
                    )

                fb_res = upload_facebook_video(
                    file_path=video_path,
                    title=title,
                    description=description,
                    progress_callback=update_fb_progress
                )
                fb_id = fb_res.get("id") if isinstance(fb_res, dict) else fb_res
                results.append(f"FB: {fb_id}")


            if post_to_tt:
                self.status_label.configure(text="TikTok: Uploading...", text_color="#1f6aa5")

                def update_tt_progress(percent):
                    self.status_label.configure(
                        text=f"TikTok Uploading: {int(percent * 100)}%", 
                        text_color="#1f6aa5"
                 )

            tt_res = upload_tiktok_video(
                file_path=video_path,
                title=title,
                progress_callback=update_tt_progress
           )
            results.append(f"TT: {tt_res.get('publish_id')})")
            self.progress_bar.set(1.0)
            self.status_label.configure(
                text=f"Done! {', '.join(results)}", 
                text_color="green"
            )

        except Exception as e:
            self.status_label.configure(text=f"Upload Failed: {e}", text_color="red")
        finally:
            self.upload_btn.configure(state="normal")


if __name__ == "__main__":
    app = VideoCrossPosterApp()
    app.mainloop()