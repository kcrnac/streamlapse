import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


REPO_ROOT = Path(__file__).parent.parent


class AnchorParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.fragment_links = set()

    def handle_starttag(self, _tag, attrs):
        attributes = dict(attrs)
        if "id" in attributes:
            self.ids.add(attributes["id"])
        if attributes.get("href", "").startswith("#") and len(attributes["href"]) > 1:
            self.fragment_links.add(attributes["href"][1:])


class DocumentationTests(unittest.TestCase):
    def test_pages_documentation_has_no_broken_fragment_links(self):
        parser = AnchorParser()
        parser.feed((REPO_ROOT / "docs" / "index.html").read_text(encoding="utf-8"))
        self.assertEqual(parser.fragment_links - parser.ids, set())

    def test_removed_scheduler_claims_do_not_return(self):
        documentation = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (
                REPO_ROOT / "README.md",
                REPO_ROOT / "docs" / "index.html",
                REPO_ROOT / "cloudflare" / "scheduler" / "README.md",
            )
        )
        stale_patterns = (
            r"GitHub Actions cron",
            r"5-minute cron",
            r"interval_minutes",
            r"07:00",
            r"17:00",
        )
        for pattern in stale_patterns:
            with self.subTest(pattern=pattern):
                self.assertIsNone(re.search(pattern, documentation, re.IGNORECASE))


if __name__ == "__main__":
    unittest.main()
