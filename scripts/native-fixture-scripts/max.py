import json
import os
import shutil
import tempfile
from pymxs import runtime as rt

with open(os.environ["SHITU_MODEL_FIXTURE_JOB"], encoding="utf-8") as stream:
    job = json.load(stream)
rt.resetMaxFile(rt.Name("noPrompt"))
obj = rt.box(length=20, width=20, height=20)
material = rt.StandardMaterial(name="Package fixture")
material.diffuseMap = rt.Bitmaptexture(filename=job["image"])
obj.material = material
if not rt.saveMaxFile(job["source"].replace("\\", "/"), quiet=True, useNewFile=False):
    # Some installations' legacy save plug-ins reject non-ASCII output paths.
    # This fallback creates only a fresh synthetic scene, then copies its bytes.
    temporary = tempfile.mkdtemp(prefix="shitu-max-fixture-")
    try:
        staging = os.path.join(temporary, "fixture.max")
        if not rt.saveMaxFile(staging, quiet=True, useNewFile=False):
            raise RuntimeError("Could not create synthetic MAX fixture")
        shutil.copyfile(staging, job["source"])
    finally:
        shutil.rmtree(temporary)
