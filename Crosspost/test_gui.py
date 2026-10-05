"""Publisher retry behavior with upload backends replaced by local fakes."""

import unittest
from unittest.mock import patch

import gui


class FakeWindow:
    def __init__(self):
        self.events = []

    def post_ui(self, **event):
        self.events.append(event)


class PublisherRetryTests(unittest.TestCase):
    def test_partial_success_disables_completed_destination_before_retry(self):
        window = FakeWindow()
        with patch.object(gui, "authenticate_youtube", return_value=object()), \
             patch.object(gui, "upload_video", return_value={"id": "yt123"}) as youtube, \
             patch.object(gui, "upload_facebook_video", side_effect=[RuntimeError("no page token"), "fb123"]) as facebook:
            gui.VideoCrossPosterApp.run_upload(
                window, "video.mp4", "", "title", "description", [], "unlisted", True, True,
            )
            self.assertIn({"completed": "youtube"}, window.events)
            self.assertNotIn({"completed": "facebook"}, window.events)
            self.assertTrue(any("Already published: YT: yt123" in event.get("text", "") for event in window.events))

            # The UI deselects/disables YouTube on the completion event. The
            # next click therefore submits only the still-selected Facebook.
            gui.VideoCrossPosterApp.run_upload(
                window, "video.mp4", "", "title", "description", [], "unlisted", False, True,
            )
            youtube.assert_called_once()
            self.assertEqual(facebook.call_count, 2)
            self.assertIn({"completed": "facebook"}, window.events)


if __name__ == "__main__":
    unittest.main()
