import json
import shutil
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import render  # noqa: E402
import fetch_jobs  # noqa: E402
import slack_post  # noqa: E402

SAMPLE = ROOT / "posts" / "example" / "sample-fse" / "post.json"


class DeadlineTest(unittest.TestCase):
    def test_dday(self):
        self.assertEqual(render.deadline_text("2026-11-16", date(2026, 11, 4)), ("D-12", "11.16(월) 마감"))
        self.assertEqual(render.deadline_text("2026-11-04", date(2026, 11, 4))[0], "D-DAY")
        self.assertEqual(render.deadline_text(None, date(2026, 11, 4))[0], "상시")

    def test_passed_deadline_is_rejected(self):
        with self.assertRaises(ValueError):
            render.deadline_text("2026-11-01", date(2026, 11, 4))


class ValidateTest(unittest.TestCase):
    def test_sample_is_valid(self):
        self.assertEqual(render.validate(json.loads(SAMPLE.read_text(encoding="utf-8"))), [])

    def test_preferred_is_optional(self):
        post = json.loads(SAMPLE.read_text(encoding="utf-8"))
        post["preferred"] = []
        self.assertEqual(render.validate(post), [])
        self.assertNotIn("preferred", render.slides_for(post))

    def test_too_many_items(self):
        post = json.loads(SAMPLE.read_text(encoding="utf-8"))
        post["duties"] = [{"text": "x"}] * 6
        self.assertTrue(render.validate(post))


class SlackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.post_dir = self.tmp / "posts" / "2026-11-04" / "sample-fse"
        self.post_dir.mkdir(parents=True)
        post = json.loads(SAMPLE.read_text(encoding="utf-8"))
        post["slides"] = 3
        (self.post_dir / "post.json").write_text(json.dumps(post, ensure_ascii=False), encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_key_and_slides(self):
        for i in (1, 2, 3):
            (self.post_dir / f"{i}.jpg").write_bytes(b"x")
        path = self.post_dir / "post.json"
        self.assertEqual(slack_post.post_key(path), "2026-11-04/sample-fse")
        slides = slack_post.slide_paths(path)
        self.assertEqual([p.name for p in slides], ["1.jpg", "2.jpg", "3.jpg"])
        post = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(slack_post.validate(post, slides), [])
        urls = [slack_post.raw_url({}, "2026-11-04/sample-fse", p.name) for p in slides]
        message = slack_post.build_message("C1", post, "2026-11-04/sample-fse", urls)
        images = [b for b in message["blocks"] if b["type"] == "image"]
        self.assertEqual(images[0]["image_url"], "https://raw.githubusercontent.com/plt8172/jdnote5/main/posts/2026-11-04/sample-fse/1.jpg")
        self.assertEqual(len(images), 3)
        self.assertEqual(message["blocks"][-1]["elements"][0]["value"], "2026-11-04/sample-fse")

    def test_gap_in_slides_is_rejected(self):
        for i in (1, 3):
            (self.post_dir / f"{i}.jpg").write_bytes(b"x")
        self.assertEqual(slack_post.slide_paths(self.post_dir / "post.json"), [])


class FetchTest(unittest.TestCase):
    def test_html_to_text(self):
        text = fetch_jobs.html_to_text("<p>Who&nbsp;We Are</p><ul><li>One</li><li>Two</li></ul>")
        self.assertEqual(text, "Who We Are\n• One\n• Two")

    def test_job_id_and_engineering(self):
        j = fetch_jobs.job("amat", "102756627104", "ETCH Process Support Engineer", "Hwaseong", "u", "2026-11-02T00:00:00")
        self.assertEqual(j["id"], "amat-102756627104")
        self.assertEqual(j["posted"], "2026-11-02")
        self.assertTrue(j["engineering"])
        self.assertFalse(fetch_jobs.job("asml", "J-1", "Finance Controller", "", "u", "")["engineering"])


if __name__ == "__main__":
    unittest.main()
