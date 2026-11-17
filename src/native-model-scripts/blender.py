"""Fixed Blender bridge: read a data-only job and export an independent GLB."""
import json
import os
import sys
import traceback
import bpy


def main(job):
    warnings = []
    root = os.path.realpath(job["bundleDirectory"])
    allowed = {os.path.normcase(os.path.realpath(os.path.join(root, item["path"]))) for item in job["manifest"]["files"]}
    by_name = {}
    for filename in allowed:
        by_name.setdefault(os.path.basename(filename).lower(), []).append(filename)

    def resolve(filename):
        absolute = os.path.normcase(os.path.realpath(bpy.path.abspath(filename)))
        if absolute in allowed:
            return absolute
        matches = by_name.get(os.path.basename(filename.replace("\\", "/")).lower(), [])
        return matches[0] if len(matches) == 1 else None

    bpy.ops.wm.open_mainfile(filepath=job["source"], load_ui=False, use_scripts=False)
    for library in bpy.data.libraries:
        if not resolve(library.filepath):
            raise RuntimeError("关联库未包含在导入的模型包中：" + os.path.basename(library.filepath))
    for image in list(bpy.data.images):
        if image.packed_file or image.source in {"GENERATED", "VIEWER"}:
            continue
        filename = resolve(image.filepath)
        if filename:
            image.filepath = filename
            image.reload()
        else:
            warnings.append("缺少包内贴图：" + image.name)
            image.filepath = ""
    for clip in bpy.data.movieclips:
        clip.filepath = ""
    for sound in bpy.data.sounds:
        if not sound.packed_file:
            sound.filepath = ""
    bpy.ops.export_scene.gltf(filepath=job["output"], export_format="GLB", export_image_format="AUTO", export_extras=False, export_cameras=False, export_lights=False)
    return warnings


job_path = os.environ.get("SHITU_MODEL_JOB") or sys.argv[sys.argv.index("--") + 1]
with open(job_path, "r", encoding="utf-8") as stream:
    job = json.load(stream)
try:
    warnings = main(job)
    result = {"ok": True, "warnings": warnings}
except Exception as error:
    result = {"ok": False, "error": str(error)}
    traceback.print_exc()
with open(job["resultPath"], "w", encoding="utf-8") as stream:
    json.dump(result, stream)
if not result["ok"]:
    raise RuntimeError(result["error"])
