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

    def test_workflows_do_not_download_mutable_ffmpeg_builds(self):
        workflow_source = "\n".join(
            path.read_text(encoding="utf-8") for path in WORKFLOW_DIR.glob("*.yml")
        )

        self.assertNotIn("FFmpeg-Builds", workflow_source)
        self.assertNotIn("releases/download/latest", workflow_source)
        self.assertIn("pip install --require-hashes", workflow_source)


if __name__ == "__main__":
    unittest.main()
