"""Constrain recording writes to explicitly configured existing project roots."""

from pathlib import Path
import json


class RecordingPaths:
    def __init__(self, roots, model="PupilCore"):
        self.model = model
        self.roots = tuple(Path(root).resolve(strict=True) for root in roots)
        if any(not root.is_dir() for root in self.roots):
            raise ValueError("Project roots must be directories")

    def recovery_directories(self):
        for root in self.roots:
            projects = [root]
            experiments = root / "experiments"
            if experiments.is_dir() and not experiments.is_symlink():
                projects.extend(p for p in experiments.iterdir() if p.is_dir() and not p.is_symlink())
            for project in projects:
                try:
                    yield self.directory(str(project))
                except (OSError, ValueError, PermissionError):
                    continue

    def directory(self, project_path: str) -> Path:
        if not isinstance(project_path, str) or not project_path:
            raise ValueError("project_path is required")
        project = Path(project_path).resolve(strict=True)
        root = next((root for root in self.roots if project == root or
                     (project.parent == root / "experiments" and project.is_relative_to(root))), None)
        if root is None:
            raise PermissionError("Project is outside configured recording roots")
        if not project.is_dir() or not (root / "project.json").is_file():
            raise ValueError("An existing MRT project with project.json is required")
        metadata_path = root / "project.json"
        if metadata_path.is_symlink():
            raise PermissionError("Project metadata must not be a symbolic link")
        if metadata_path.stat().st_size > 1024 * 1024:
            raise ValueError("Project metadata is too large")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict) or metadata.get("deviceModel") != self.model:
            raise ValueError(f"Recording requires a {self.model} project; other models cannot be reused")
        for modality in metadata.get("modalities", []):
            if modality.get("id") == "eye-tracking" and modality.get("config", {}).get("deviceModel") != self.model:
                raise ValueError("Conflicting project eye-tracker identity")
        directory = project / "recordings"
        if directory.is_symlink() or directory.resolve() != directory:
            raise PermissionError("Recording directory must not redirect outside the project")
        return directory
