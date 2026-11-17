"""Isolated local U2Net inference. Invoked only by ai-image-engine.cjs."""
import ctypes
import json
import os
import sys
import time
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def adapters():
    # DXGI ordering is the ordering expected by DirectML's device_id.
    if os.name != "nt":
        return []
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                    ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]

    class LUID(ctypes.Structure):
        _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]

    class DESC(ctypes.Structure):
        _fields_ = [("Description", ctypes.c_wchar * 128), ("VendorId", wintypes.UINT),
                    ("DeviceId", wintypes.UINT), ("SubSysId", wintypes.UINT),
                    ("Revision", wintypes.UINT), ("DedicatedVideoMemory", ctypes.c_size_t),
                    ("DedicatedSystemMemory", ctypes.c_size_t), ("SharedSystemMemory", ctypes.c_size_t),
                    ("AdapterLuid", LUID), ("Flags", wintypes.UINT)]

    def method(obj, index, *argtypes):
        table = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        return ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *argtypes)(table[index])

    result = []
    factory = ctypes.c_void_p()
    iid = GUID.from_buffer_copy(uuid.UUID("770aae78-f26f-4dba-a829-253c83d1b387").bytes_le)
    dxgi = ctypes.WinDLL("dxgi.dll")
    dxgi.CreateDXGIFactory1.argtypes = [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    hr = dxgi.CreateDXGIFactory1(ctypes.byref(iid), ctypes.byref(factory))
    if hr < 0:
        return []
    try:
        for index in range(32):
            adapter = ctypes.c_void_p()
            hr = method(factory, 12, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p))(
                factory, index, ctypes.byref(adapter))
            if hr < 0:
                break
            try:
                desc = DESC()
                if method(adapter, 10, ctypes.POINTER(DESC))(adapter, ctypes.byref(desc)) >= 0:
                    result.append({"id": index, "name": desc.Description,
                                   "memoryBytes": desc.DedicatedVideoMemory,
                                   "software": bool(desc.Flags & 2), "vendorId": desc.VendorId})
            finally:
                method(adapter, 2)(adapter)
    finally:
        method(factory, 2)(factory)
    return result


def main(request):
    import numpy as np
    import onnxruntime as ort
    from PIL import Image, ImageOps, ImageChops

    available = ort.get_available_providers()
    devices = adapters()
    hardware = [d for d in devices if not d["software"] and d["vendorId"] in (0x10DE, 0x1002, 0x8086)]
    hardware.sort(key=lambda d: d["memoryBytes"], reverse=True)
    if request.get("action") == "probe":
        return {"providers": available, "devices": devices, "preferredDevice": hardware[0] if hardware else None}

    start = time.perf_counter()
    image = ImageOps.exif_transpose(Image.open(request["inputPath"]))
    image.load()
    if image.width * image.height > 100_000_000:
        raise ValueError("图片超过一亿像素，请先缩小后再处理")
    rgba = image.convert("RGBA")
    rgb = rgba.convert("RGB")
    resized = np.asarray(rgb.resize((320, 320), Image.Resampling.LANCZOS), dtype=np.float32)
    maximum = float(resized.max())
    if maximum > 0:
        resized /= maximum
    resized = (resized - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    data = np.transpose(resized, (2, 0, 1))[None].astype(np.float32)
    requested = request.get("device", "auto")
    use_gpu = requested != "cpu" and "DmlExecutionProvider" in available and bool(hardware)
    if requested == "gpu" and not use_gpu:
        raise RuntimeError("未找到可用的 DirectML 显卡；请选择自动或 CPU")
    fallback = None

    def infer(gpu):
        opts = ort.SessionOptions()
        opts.enable_mem_pattern = False
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.log_severity_level = 3
        opts.enable_profiling = True
        opts.profile_file_prefix = os.path.join(request["workDir"], "onnx-profile")
        providers = [("DmlExecutionProvider", {"device_id": hardware[0]["id"]}), "CPUExecutionProvider"] if gpu else ["CPUExecutionProvider"]
        emit({"type": "progress", "progress": 0.2, "message": "正在加载抠图模型", "provider": providers[0][0] if gpu else providers[0]})
        session = ort.InferenceSession(request["modelPath"], sess_options=opts, providers=providers)
        emit({"type": "progress", "progress": 0.4, "message": "正在识别主体"})
        prediction = session.run(None, {session.get_inputs()[0].name: data})[0][:, 0, :, :]
        profile_path = session.end_profiling()
        with open(profile_path, "r", encoding="utf-8") as handle:
            events = json.load(handle)
        os.unlink(profile_path)
        counts = {}
        for event in events:
            provider = event.get("args", {}).get("provider")
            if provider:
                counts[provider] = counts.get(provider, 0) + 1
        if gpu and not counts.get("DmlExecutionProvider"):
            raise RuntimeError("DirectML 没有执行模型节点，无法确认 GPU 推理")
        return prediction, counts

    try:
        prediction, counts = infer(use_gpu)
    except Exception as error:
        if requested != "auto" or not use_gpu:
            raise
        fallback = "GPU 推理不可用，已改用 CPU：" + str(error)[:240]
        use_gpu = False
        prediction, counts = infer(False)
    pred = prediction.squeeze()
    minimum, maximum = float(pred.min()), float(pred.max())
    pred = (pred - minimum) / max(maximum - minimum, 1e-8)
    mask = Image.fromarray((np.clip(pred, 0, 1) * 255).astype(np.uint8)).resize(rgba.size, Image.Resampling.LANCZOS)
    # Do not turn already transparent source pixels opaque.
    mask = ImageChops.multiply(mask, rgba.getchannel("A"))
    rgba.putalpha(mask)
    emit({"type": "progress", "progress": 0.9, "message": "正在保存透明图片"})
    rgba.save(request["outputPath"], format="PNG")
    return {"outputPath": request["outputPath"], "width": rgba.width, "height": rgba.height,
            "engine": "U²-Net / ONNX Runtime", "provider": "DirectML" if use_gpu else "CPU",
            "accelerator": "gpu" if use_gpu else "cpu", "device": hardware[0] if use_gpu else None,
            "elapsedMs": round((time.perf_counter() - start) * 1000), "fallback": fallback,
            "diagnostics": {"executedProviders": counts, "alphaMin": mask.getextrema()[0], "alphaMax": mask.getextrema()[1]}}


if __name__ == "__main__":
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as handle:
            request = json.load(handle)
        emit({"type": "result", "result": main(request)})
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        sys.exit(1)
