"""Fixed c4dpy bridge. Requires a usable local Cinema 4D installation/license."""
import json
import os
import sys
import traceback

# This bridge's filename is c4d.py; remove its folder before importing the SDK.
sys.path = [entry for entry in sys.path if os.path.realpath(entry or os.getcwd()) != os.path.dirname(os.path.realpath(__file__))]
import c4d


def descendants(item):
    while item:
        yield item
        for child in descendants(item.GetDown()):
            yield child
        item = item.GetNext()


def main(job):
    warnings = []
    document = c4d.documents.LoadDocument(job["source"], c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS, None)
    if not document:
        raise RuntimeError("Cinema 4D 无法读取此工程")
    root = os.path.realpath(job["bundleDirectory"])
    allowed = {os.path.normcase(os.path.realpath(os.path.join(root, item["path"]))) for item in job["manifest"]["files"]}
    by_name = {}
    for filename in allowed:
        by_name.setdefault(os.path.basename(filename).lower(), []).append(filename)
    for obj in descendants(document.GetFirstObject()):
        for tag in list(obj.GetTags()):
            if tag.GetType() in {getattr(c4d, "Tpython", -1), getattr(c4d, "Tcoffee", -2)}:
                tag.Remove()
                warnings.append("预览已忽略脚本标签")
        if obj.GetType() == getattr(c4d, "Opython", -1):
            obj[c4d.ID_BASEOBJECT_GENERATOR_FLAG] = False
            warnings.append("预览已忽略 Python 生成器")
    material = document.GetFirstMaterial()
    while material:
        for shader in descendants(material.GetFirstShader()):
            if shader.GetType() == c4d.Xbitmap:
                old = shader[c4d.BITMAPSHADER_FILENAME] or ""
                candidate = os.path.normcase(os.path.realpath(os.path.join(os.path.dirname(job["source"]), old)))
                matches = by_name.get(os.path.basename(old.replace("\\", "/")).lower(), [])
                target = candidate if candidate in allowed else matches[0] if len(matches) == 1 else ""
                shader[c4d.BITMAPSHADER_FILENAME] = target
                if old and not target:
                    warnings.append("缺少包内贴图：" + os.path.basename(old))
        material = material.GetNext()
    document.ExecutePasses(None, True, True, True, c4d.BUILDFLAGS_NONE)
    plugin_id = getattr(c4d, "FORMAT_FBX_EXPORT", 1026370)
    plugin = c4d.plugins.FindPlugin(plugin_id, c4d.PLUGINTYPE_SCENESAVER)
    data = {}
    if not plugin or not plugin.Message(c4d.MSG_RETRIEVEPRIVATEDATA, data):
        raise RuntimeError("Cinema 4D 的 FBX 导出器不可用")
    settings = data.get("imexporter")
    if settings is not None:
        settings[c4d.FBXEXPORT_EMBED_TEXTURES] = True
        if hasattr(c4d, "FBXEXPORT_SAVE_NORMALS"):
            settings[c4d.FBXEXPORT_SAVE_NORMALS] = True
    if not c4d.documents.SaveDocument(document, job["output"], c4d.SAVEDOCUMENTFLAGS_DONTADDTORECENTLIST, plugin_id):
        raise RuntimeError("Cinema 4D 未能导出 FBX 预览")
    c4d.documents.KillDocument(document)
    warnings.append("原工程专用渲染器材质在通用预览中可能有差异")
    return warnings


with open(os.environ.get("SHITU_MODEL_JOB") or sys.argv[-1], "r", encoding="utf-8") as stream:
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
