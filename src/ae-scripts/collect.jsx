/* Fixed After Effects bridge. File I/O is read-only; host Node copies assets.
 * Native Project.save writes only the explicitly supplied fresh job paths.
 * The launcher MUST pass -m -noui so this never targets an artist's session. */
(function () {
    var marker = "SHITU_AE_REPORT_V1:", project = null, job = null, ownedInstance = false;
    function stringify(value) {
        if (value === null) return "null";
        if (typeof value === "string") return '"' + value.replace(/[\\"\u0000-\u001f]/g, function (c) {
            if (c === "\\" || c === '"') return "\\" + c;
            return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
        if (typeof value === "number") return isFinite(value) ? String(value) : "null";
        if (typeof value === "boolean") return value ? "true" : "false";
        var parts = [], key, i;
        if (value instanceof Array) {
            for (i = 0; i < value.length; i++) parts.push(stringify(value[i]));
            return "[" + parts.join(",") + "]";
        }
        for (key in value) if (value.hasOwnProperty(key) && typeof value[key] !== "undefined") parts.push(stringify(key) + ":" + stringify(value[key]));
        return "{" + parts.join(",") + "}";
    }
    function parse(text) {
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
        // The json2 grammar guard permits JSON data only, never script tokens.
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
            item.comment = marker + job.token + ":" + i + ":" + count + ":" + encoded.substr(i * length, length);
        }
        project.save(new File(job.reportProject));
    }
    function sourceRecord(item, source, role) {
        if (!source || !(source instanceof FileSource)) return null;
        var file = source.file, filename = file ? file.fsName : "";
        if (!filename) try { filename = source.missingFootagePath || ""; } catch (ignored) {}
        if (!filename) return null;
        var result = { itemId: item.id, itemIndex: item.index, role: role, source: filename,
            missing: !file || !file.exists, isStill: source.isStill, useProxy: !!item.useProxy, interpretation: {} };
        var keys = ["conformFrameRate", "alphaMode", "premulColor", "invertAlpha", "loop", "fieldSeparationType", "removePulldown", "highQualityFieldSeparation"], i;
        for (i = 0; i < keys.length; i++) try { result.interpretation[keys[i]] = source[keys[i]]; } catch (ignored2) {}
        return result;
    }
    function inspect() {
        var sources = [], i, item, record, compositions = [];
        for (i = 1; i <= project.numItems; i++) {
            item = project.item(i);
            if (item instanceof FootageItem) { record = sourceRecord(item, item.mainSource, "main"); if (record) sources.push(record); }
            if (item instanceof FootageItem || item instanceof CompItem) { record = sourceRecord(item, item.proxySource, "proxy"); if (record) sources.push(record); }
            if (item instanceof CompItem) {
                var usedInCount = 0;
                try { usedInCount = item.usedIn.length; } catch (ignored3) {}
                compositions.push({ id: item.id, index: i, name: item.name, width: item.width, height: item.height,
                    duration: item.duration, frameRate: item.frameRate, workAreaStart: item.workAreaStart,
                    workAreaDuration: item.workAreaDuration, usedInCount: usedInCount });
            }
        }
        return { ok: true, version: app.version, sources: sources, compositions: compositions };
    }
    function removeMetadata() {
        var folders = [];
        for (var i = project.numItems; i >= 1; i--) {
            var item = project.item(i);
            if (item instanceof FolderItem && item.name === "__Shitu_Metadata_" + job.token) folders.push(item);
        }
        for (i = 0; i < folders.length; i++) folders[i].remove();
    }
    try {
        // Empty new-instance guard is intentionally before opening anything.
        if (app.project && (app.project.file || app.project.numItems > 0)) throw new Error("An existing project was detected; collection refused");
        ownedInstance = true;
        app.exitAfterLaunchAndEval = true;
        if (typeof app.setSavePreferencesOnQuit === "function") app.setSavePreferencesOnQuit(false);
        var jobFile = new File($.getenv("SHITU_AE_JOB")); jobFile.encoding = "UTF-8";
        if (!jobFile.open("r")) throw new Error("Cannot read collection task");
        try { job = parse(jobFile.read()); } finally { jobFile.close(); }
        if (job.protocol !== 1 || !/^[a-f0-9-]{36}$/.test(job.token)) throw new Error("Invalid collection task marker");
        app.beginSuppressDialogs();
        if (job.mode === "fixture") {
            project = app.project || app.newProject();
            var comp = project.items.addComp("Shitu AE Fixture", 160, 96, 1, 1, 24);
            var image = project.importFile(new ImportOptions(new File(job.image))); comp.layers.add(image);
            var firstFrameStill = project.importFile(new ImportOptions(new File(job.sequence))); comp.layers.add(firstFrameStill);
            var sequenceImport = new ImportOptions(new File(job.sequence)); sequenceImport.sequence = true; sequenceImport.forceAlphabetical = false;
            var sequence = project.importFile(sequenceImport); sequence.mainSource.conformFrameRate = 12; comp.layers.add(sequence);
            image.setProxy(new File(job.proxy)); image.useProxy = false;
            comp.setProxyWithSequence(new File(job.sequence), false); comp.useProxy = false;
            project.save(new File(job.output));
            report(inspect());
        } else {
            project = app.open(new File(job.source));
            if (!project) throw new Error("After Effects did not open the source project");
            if (job.mode === "collect") {
                removeMetadata();
                project.save(new File(job.output));
            }
            report(inspect());
        }
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
