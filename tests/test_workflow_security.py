import re
import unittest
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).parent.parent
WORKFLOW_DIR = REPO_ROOT / ".github" / "workflows"
SHA_PIN = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


class WorkflowSecurityTests(unittest.TestCase):
    def test_dispatch_inputs_are_not_embedded_in_generate_shell_source(self):
        workflow = yaml.load(
            (WORKFLOW_DIR / "generate.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )
        steps = workflow["jobs"]["generate"]["steps"]
        generate_step = next(step for step in steps if step.get("name") == "Generate timelapse")

        self.assertNotIn("${{ inputs.", generate_step["run"])
        self.assertEqual(generate_step["env"]["INPUT_DATE_FROM"], "${{ inputs.date_from }}")
        self.assertEqual(generate_step["env"]["INPUT_DATE_TO"], "${{ inputs.date_to }}")
        self.assertEqual(generate_step["env"]["INPUT_FPS"], "${{ inputs.fps }}")
        self.assertEqual(generate_step["env"]["INPUT_OUTPUT"], "${{ inputs.output }}")

    def test_all_actions_are_pinned_to_full_commit_shas(self):
        for workflow_path in WORKFLOW_DIR.glob("*.yml"):
            workflow = yaml.load(workflow_path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
            for job in workflow.get("jobs", {}).values():
                for step in job.get("steps", []):
                    if "uses" in step:
                        with self.subTest(workflow=workflow_path.name, action=step["uses"]):
                            self.assertRegex(step["uses"], SHA_PIN)

    def test_workflows_use_an_immutable_verified_ffmpeg_build(self):
        capture_source = (WORKFLOW_DIR / "capture.yml").read_text(encoding="utf-8")
        generate_source = (WORKFLOW_DIR / "generate.yml").read_text(encoding="utf-8")
        setup_source = (
            REPO_ROOT / ".github" / "scripts" / "setup-ffmpeg-linux.sh"
        ).read_text(encoding="utf-8")

        self.assertNotIn("releases/download/latest", setup_source)
        self.assertIn("autobuild-2026-08-27-16-45", setup_source)
        self.assertIn(
            'archive_sha256="5422737149e93e157bd736b699be798e1f6d9ecbd97751a761e2518593004a89"',
            setup_source,
        )
        self.assertIn(
            'binary_sha256="90f0f2d8326a62da86a94548a1bfa255140934512af8c32d39a07499da0ea4c3"',
            setup_source,
        )
        for workflow_source in (capture_source, generate_source):
            self.assertIn("setup-ffmpeg-linux.sh", workflow_source)
            self.assertIn(".cache/ffmpeg", workflow_source)
            self.assertIn("GITHUB_PATH", workflow_source)
            self.assertIn("pip install --require-hashes", workflow_source)

    def test_cloudflare_is_the_only_capture_scheduler(self):
        capture_workflow = yaml.load(
            (WORKFLOW_DIR / "capture.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )
        project_config = yaml.safe_load(
            (REPO_ROOT / "config.yml").read_text(encoding="utf-8"),
        )
        worker_source = (
            REPO_ROOT / "cloudflare" / "scheduler" / "src" / "index.ts"
        ).read_text(encoding="utf-8")

        self.assertEqual(set(capture_workflow["on"]), {"workflow_dispatch"})
        self.assertNotIn("schedule", project_config)
        self.assertNotIn("raw.githubusercontent.com", worker_source)
        self.assertNotIn("config.yml", worker_source)


if __name__ == "__main__":
    unittest.main()
