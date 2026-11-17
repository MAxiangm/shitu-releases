import json
import os
import bpy

with open(os.environ["SHITU_MODEL_FIXTURE_JOB"], encoding="utf-8") as stream:
    job = json.load(stream)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
material = bpy.data.materials.new("Package fixture")
material.use_nodes = True
image_node = material.node_tree.nodes.new("ShaderNodeTexImage")
image_node.image = bpy.data.images.load(job["image"])
image_node.image.filepath = "//tex/fixture.png"
material.node_tree.links.new(image_node.outputs["Color"], material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"])
bpy.context.active_object.data.materials.append(material)
bpy.ops.wm.save_as_mainfile(filepath=job["source"])
