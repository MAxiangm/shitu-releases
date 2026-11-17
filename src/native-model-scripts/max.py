"""Fixed 3ds Max Batch bridge; launched through max.ms with Safe Scene enabled."""
import json
import os
import traceback
from pymxs import runtime as rt


def main(job):
    warnings = []
    rt.resetMaxFile(rt.Name("noPrompt"))
    if not rt.loadMaxFile(job["source"], quiet=True):
        raise RuntimeError("3ds Max 无法读取此工程")
    root = os.path.realpath(job["bundleDirectory"])
    allowed = {os.path.normcase(os.path.realpath(os.path.join(root, item["path"]))) for item in job["manifest"]["files"]}
    by_name = {}
    for filename in allowed:
        by_name.setdefault(os.path.basename(filename).lower(), []).append(filename)
    for bitmap in rt.getClassInstances(rt.Bitmaptexture):
        old = str(bitmap.filename or "")
        candidate = os.path.normcase(os.path.realpath(os.path.join(os.path.dirname(job["source"]), old)))
        matches = by_name.get(os.path.basename(old.replace("\\", "/")).lower(), [])
        target = candidate if candidate in allowed else matches[0] if len(matches) == 1 else ""
        bitmap.filename = target
        if old and not target:
            warnings.append("缺少包内贴图：" + os.path.basename(old))
    rt.pluginManager.loadClass(rt.FbxExporter)
    rt.FBXExporterSetParam("EmbedTextures", True)
    rt.FBXExporterSetParam("Cameras", False)
    rt.FBXExporterSetParam("Lights", False)
    rt.FBXExporterSetParam("Triangulate", True)
    rt.FBXExporterSetParam("ASCII", False)
    if not rt.exportFile(job["output"], rt.Name("noPrompt"), selectedOnly=False, using=rt.FBXEXP):
        raise RuntimeError("3ds Max 未能导出 FBX 预览")
    warnings.append("原工程专用渲染器材质在通用预览中可能有差异")
    return warnings


with open(os.environ["SHITU_MODEL_JOB"], "r", encoding="utf-8") as stream:
    job = json.load(stream)
try:
    result = {"ok": True, "warnings": main(job)}
except Exception as error:
    result = {"ok": False, "error": str(error)}
    traceback.print_exc()
with open(job["resultPath"], "w", encoding="utf-8") as stream:
    json.dump(result, stream)
if not result["ok"]:
    raise RuntimeError(result["error"])
