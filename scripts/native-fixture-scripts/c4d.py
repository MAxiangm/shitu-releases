import json
import os
import sys
sys.path = [entry for entry in sys.path if os.path.realpath(entry or os.getcwd()) != os.path.dirname(os.path.realpath(__file__))]
import c4d

with open(os.environ["SHITU_MODEL_FIXTURE_JOB"], encoding="utf-8") as stream:
    job = json.load(stream)
document = c4d.documents.BaseDocument()
cube = c4d.BaseObject(c4d.Ocube)
document.InsertObject(cube)
material = c4d.BaseMaterial(c4d.Mmaterial)
bitmap = c4d.BaseShader(c4d.Xbitmap)
bitmap[c4d.BITMAPSHADER_FILENAME] = "tex/fixture.png"
material.InsertShader(bitmap)
material[c4d.MATERIAL_COLOR_SHADER] = bitmap
document.InsertMaterial(material)
tag = cube.MakeTag(c4d.Ttexture)
tag[c4d.TEXTURETAG_MATERIAL] = material
if not c4d.documents.SaveDocument(document, job["source"], c4d.SAVEDOCUMENTFLAGS_DONTADDTORECENTLIST, c4d.FORMAT_C4DEXPORT):
    raise RuntimeError("Could not create synthetic C4D fixture")
c4d.documents.KillDocument(document)
