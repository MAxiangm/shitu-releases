/* Fixed, data-only bridge. Run exclusively in a new AfterFX -m -noui instance.
 * File I/O is read-only; native Project.save writes fresh host-provided paths.
 * Never change script security preferences or a user's saved render templates. */
(function () {
    var project = null, job = null, ownedInstance = false;
    function stringify(value) {
        if (value === null) return "null";
        if (typeof value === "string") return '"' + value.replace(/[\\"\u0000-\u001f]/g, function (c) {
            return c === "\\" || c === '"' ? "\\" + c : "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
        if (typeof value === "number") return isFinite(value) ? String(value) : "null";
        if (typeof value === "boolean") return value ? "true" : "false";
        var parts = [], key, i;
        if (value instanceof Array) { for (i = 0; i < value.length; i++) parts.push(stringify(value[i])); return "[" + parts.join(",") + "]"; }
        for (key in value) if (value.hasOwnProperty(key) && typeof value[key] !== "undefined") parts.push(stringify(key) + ":" + stringify(value[key]));
        return "{" + parts.join(",") + "}";
    }
    function parse(text) {
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
        if (!/^[\],:{}\s]*$/.test(text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
            .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
            .replace(/(?:^|:|,)(?:\s*\[)+/g, ""))) throw new Error("Invalid task JSON");
        return eval("(" + text + ")");
    }
    function report(value) {
        if (!project) project = app.project || app.newProject();
        var encoded = encodeURIComponent(stringify(value)), length = 2500, count = Math.max(1, Math.ceil(encoded.length / length));
        var folder = project.items.addFolder("__Shitu_Metadata_" + job.token), i, item;
        for (i = 0; i < count; i++) {
            item = project.items.addFolder("part-" + ("00000" + i).slice(-5)); item.parentFolder = folder;
            item.comment = "SHITU_AE_REPORT_V1:" + job.token + ":" + i + ":" + count + ":" + encoded.substr(i * length, length);
        }
        project.save(new File(job.reportProject));
    }
    function compositionInfo(comp, index) {
        return { id: comp.id, index: index, name: comp.name, width: comp.width, height: comp.height,
            pixelAspect: comp.pixelAspect, duration: comp.duration, frameRate: comp.frameRate,
            workAreaStart: comp.workAreaStart, workAreaDuration: comp.workAreaDuration,
            usedInCount: comp.usedIn.length, hasAudio: comp.hasAudio };
    }
    function score(comp) {
        var value = Math.log(Math.max(1, comp.width * comp.height)) + Math.log(Math.max(1, comp.duration));
        if (/^(?:main|final|master|主合成|最终|成片)(?:\b|[ _\-\d])/i.test(comp.name) || /^(?:main|final|master|主合成|最终|成片)$/i.test(comp.name)) value += 3;
        return value;
    }
    function completePNG(file) {
        if (!file.exists || file.length < 20) return false;
        file.encoding = "BINARY";
        try {
            if (!file.open("r")) return false;
            if (!file.seek(file.length - 12, 0)) return false;
            return file.read(12) === "\x00\x00\x00\x00IEND\xae\x42\x60\x82";
        } finally { try { file.close(); } catch (ignoredClose) {} }
    }
    try {
        // This guard precedes every mutation, including close/quit in finally.
        if (app.project && (app.project.file || app.project.numItems > 0)) throw new Error("An existing project was detected; preview refused");
        ownedInstance = true;
        app.exitAfterLaunchAndEval = true;
        if (typeof app.setSavePreferencesOnQuit === "function") app.setSavePreferencesOnQuit(false);
        var jobFile = new File($.getenv("SHITU_AE_PREVIEW_JOB")); jobFile.encoding = "UTF-8";
        if (!jobFile.open("r")) throw new Error("Cannot read preview task");
        try { job = parse(jobFile.read()); } finally { jobFile.close(); }
        if (job.protocol !== 1 || !/^[a-f0-9-]{36}$/.test(job.token)) throw new Error("Invalid task marker");
        app.beginSuppressDialogs();
        project = app.open(new File(job.source));
        if (!project) throw new Error("After Effects did not open the project");
        var compositions = [], candidates = [], allComps = [], selected = null, i, comp, item;
        for (i = 1; i <= project.numItems; i++) {
            item = project.item(i);
            if (item instanceof CompItem) {
                compositions.push(compositionInfo(item, i));
                if (job.compositionId !== null && typeof job.compositionId !== "undefined" && String(item.id) === String(job.compositionId)) selected = item;
                if (item.duration > 0) { allComps.push(item); if (item.usedIn.length === 0) candidates.push(item); }
            }
        }
        if (job.compositionId !== null && typeof job.compositionId !== "undefined" && !selected) throw new Error("Selected composition no longer exists");
        if (!selected) {
            if (!candidates.length) candidates = allComps;
            for (i = 0; i < candidates.length; i++) if (!selected || score(candidates[i]) > score(selected)) selected = candidates[i];
        }
        if (!selected || !(selected.duration > 0)) throw new Error("No non-empty composition is available");
        var original = null;
        for (i = 0; i < compositions.length; i++) if (compositions[i].id === selected.id) original = compositions[i];
        var factor = Math.min(1, 1280 / (selected.width * selected.pixelAspect), 720 / selected.height);
        var width = Math.max(4, 2 * Math.floor(selected.width * selected.pixelAspect * factor / 2));
        var height = Math.max(4, 2 * Math.floor(selected.height * factor / 2));
        var fps = selected.frameRate;
        var seconds = selected.duration;
        // A wrapper changes output dimensions/rate without touching source animation,
        // expressions, renderer or nested compositions in the managed project.
        var preview = project.items.addComp("__Shitu_Preview_" + job.token, width, height, 1, seconds, fps);
        preview.bgColor = selected.bgColor;
        var layer = preview.layers.add(selected);
        layer.startTime = 0;
        layer.property("ADBE Transform Group").property("ADBE Position").setValue([width / 2, height / 2]);
        layer.property("ADBE Transform Group").property("ADBE Scale").setValue([100 * width / (selected.width * selected.pixelAspect), 100 * height / selected.height]);
        try { layer.audioEnabled = true; } catch (ignoredAudio) {}
        var begin = Math.max(0, Math.min(seconds, original.workAreaStart)), length = Math.min(seconds - begin, original.workAreaDuration);
        if (!(length > 0)) { begin = 0; length = seconds; }
        var frameTimes = [begin + Math.min(1, length * 0.1), begin + length * 0.5, begin + length * 0.8], outputs = [], warnings = [], time, target, deadline, deferred;
        if (!(frameTimes instanceof Array) || frameTimes.length < 1 || frameTimes.length > 3) throw new Error("Invalid representative frame times");
        try { app.setMemoryUsageLimits(10, 30); } catch (memoryError) {}
        for (i = 0; i < frameTimes.length; i++) {
            time = Math.max(0, Math.min(seconds - 1 / fps, Number(frameTimes[i])));
            if (!isFinite(time)) throw new Error("Invalid representative frame time");
            target = new File(job.outputDirectory + "/frame-" + i + ".png");
            try {
            deferred = preview.saveFrameToPng(time, target);
            if (deferred && typeof deferred.wait === "function") deferred.wait();
            // Recent AE versions can return while the native PNG writer is still
            // finishing. Keep our own instance alive until each output exists.
            deadline = new Date().getTime() + 10000;
            while (!completePNG(target)) {
                if (new Date().getTime() > deadline) throw new Error("After Effects did not finish the representative frame");
                $.sleep(50); target = new File(target.fsName);
            }
            outputs.push({ path: target.fsName, time: time });
            } catch (frameError) { warnings.push("部分代表帧未能生成，已使用其余有效画面。"); }
        }
        if (!outputs.length) throw new Error("After Effects did not generate a valid representative frame");
        report({ ok: true, version: app.version, composition: original, compositions: compositions,
            width: width, height: height, frameRate: fps, duration: seconds, frames: outputs, warnings: warnings });
        app.exitCode = 0;
    } catch (error) {
        if (!ownedInstance) throw error;
        app.exitCode = 17;
        if (job) try { report({ ok: false, error: String(error), line: error.line || 0 }); } catch (reportFailure) {}
    } finally {
        if (ownedInstance) {
            try { if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (closeFailure) {}
            try { app.endSuppressDialogs(false); } catch (dialogFailure) {}
            app.quit();
        }
    }
})();
