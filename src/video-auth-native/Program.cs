// Dedicated YouTube login helper for Mosaic. Connection flow is adapted from
// the user-provided 2026-10-13 bang payload/YouTubeConnection.cs; CurrentUser
// DPAPI persistence follows that payload's Source.cs SaveEncryptedSession.
// No existing browser profile, cookie database, or legacy session is opened.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;

internal sealed class NativeFailure : Exception {
 internal readonly string Code;
 internal NativeFailure(string code, string message) : base(message) { Code = code; }
}

internal static class Program {
 [STAThread]
 static int Main(string[] arguments) {
  Console.OutputEncoding = new UTF8Encoding(false);
  TextWriter stdout = Console.Out;
  using (var cancellation = new CancellationTokenSource()) {
   string mode = null;
   try {
    var args = Parse(arguments, out mode);
    var state = new NativeState(args["--state-dir"]);
    string url = args.ContainsKey("--url") ? CanonicalUrl(args["--url"]) : "https://www.youtube.com/";
    if (mode == "--connect") {
     var reader = new Thread(() => {
      try { using (var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8)) {
       string line; while ((line = input.ReadLine()) != null) if (line == "cancel") { cancellation.Cancel(); return; }
      } } catch { }
     });
     reader.IsBackground = true; reader.Start();
     int exit = 1;
     var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
     app.Startup += async (sender, e) => {
      try {
       using (state.Acquire()) {
        cancellation.Token.ThrowIfCancellationRequested();
        var lines = await YouTubeConnection.ConnectAsync(null, state.Root, url, cancellation.Token);
        cancellation.Token.ThrowIfCancellationRequested();
        state.Save(lines, cancellation.Token);
        Write(new { ok = true, connected = true }); exit = 0;
       }
      } catch (Exception error) { WriteError(error, mode); }
      finally { app.Shutdown(); }
     };
     app.Run(); return exit;
    }
    using (state.Acquire()) {
     cancellation.Token.ThrowIfCancellationRequested();
     if (mode == "--status") {
      if (!state.Exists) Write(new { ok = true, connected = false });
      else { byte[] value = state.Read(cancellation.Token); Array.Clear(value, 0, value.Length); Write(new { ok = true, connected = true }); }
     } else if (mode == "--export") {
      state.Export(args["--output"], cancellation.Token); Write(new { ok = true, exported = true });
     } else if (mode == "--export-browser-session") {
      using (var input = Console.OpenStandardInput()) state.ExportBrowserSession(args["--site"], args["--output"], input, cancellation.Token);
      Write(new { ok = true });
     } else if (mode == "--disconnect") {
      state.Disconnect(cancellation.Token); Write(new { ok = true, connected = false });
     } else if (mode == "--self-test") {
      state.SelfTest(cancellation.Token); Write(new { ok = true, selfTest = true, dpapi = true, protectedData = true, roundTrip = true, privateExport = true, noBrowser = true, connected = false });
     }
    }
    return 0;
   } catch (Exception error) { WriteError(error, mode); return 1; }
  }
 }
 static Dictionary<string,string> Parse(string[] args, out string mode) {
  mode = null;
  var result = new Dictionary<string,string>(StringComparer.Ordinal);
  var modes = new[] { "--connect", "--export", "--export-browser-session", "--disconnect", "--status", "--self-test" };
  for (int i = 0; i < args.Length; i++) {
   string key = args[i];
   if (modes.Contains(key)) { if (mode != null) throw Arguments(); mode = key; continue; }
   if (!new[] { "--site", "--state-dir", "--url", "--output" }.Contains(key) || result.ContainsKey(key) || ++i >= args.Length) throw Arguments();
   result[key] = args[i];
  }
  if (mode == null || !result.ContainsKey("--site") ||
      (result["--site"] != "youtube" && (mode != "--export-browser-session" || result["--site"] != "bilibili")) || !result.ContainsKey("--state-dir") ||
      (mode == "--export" || mode == "--export-browser-session") != result.ContainsKey("--output") || (result.ContainsKey("--url") && mode != "--connect")) throw Arguments();
  return result;
 }
 static NativeFailure Arguments() { return new NativeFailure("AUTH_ARGUMENT_INVALID", "YouTube 连接参数无效。"); }
 static string CanonicalUrl(string value) {
  if (!Regex.IsMatch(value ?? "", @"\Ahttps://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}\z", RegexOptions.CultureInvariant)) throw Arguments();
  return value;
 }
 static void Write(object value) { Console.Out.WriteLine(new JavaScriptSerializer().Serialize(value)); }
 static void WriteError(Exception error, string mode) {
  var known = error as NativeFailure;
  string code, message;
  if (known != null) { code = known.Code; message = known.Message; }
  else if (error is OperationCanceledException) { code = "AUTH_CANCELLED"; message = "YouTube 连接已取消。"; }
  else if (error is CryptographicException) { code = "AUTH_EXPIRED"; message = "YouTube 登录会话无法读取，请重新连接。"; }
  else if (error.Message.StartsWith("Google 拒绝", StringComparison.Ordinal)) { code = "AUTH_REJECTED"; message = "Google 拒绝了此次登录，请保持账号安全设置并稍后重试。"; }
  else if (error is FileNotFoundException && mode == "--connect") { code = "AUTH_BROWSER_MISSING"; message = "未找到 Google Chrome 或 Microsoft Edge，请安装 Google Chrome 后重试。"; }
  else if (mode == "--export") { code = "AUTH_EXPORT_FAILED"; message = "YouTube 登录会话无法安全导出，请重新连接。"; }
  else if (mode == "--export-browser-session") { code = "AUTH_STORAGE"; message = "当前浏览器登录信息无法安全导出，请重试。"; }
  else { code = "AUTH_CONNECT_FAILED"; message = "YouTube 连接未完成，请关闭本次专用登录窗口后重试。"; }
  Write(new { ok = false, code = code, error = message });
 }
}

internal sealed class NativeState {
 internal readonly string Root;
 readonly string session, marker, exports;
 readonly string[] profiles;
 const int MaxSessionBytes = 2 * 1024 * 1024;
 const int MaxBrowserSessionBytes = 512 * 1024;
 const string MarkerText = "Mosaic video authentication v1\nyoutube\n";
 static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
 internal NativeState(string input) {
  Root = Absolute(input);
  if (Root.Length <= Path.GetPathRoot(Root).Length || Root.StartsWith(@"\\", StringComparison.Ordinal)) throw InvalidState();
  CheckAncestors(Root);
  session = Path.Combine(Root, "youtube-session.dpapi"); marker = Path.Combine(Root, ".mosaic-video-auth-v1");
  profiles = new[] { "youtube-profile", "youtube-profile-chrome", "youtube-profile-edge" }.Select(name => Path.Combine(Root, name)).ToArray();
  exports = Path.Combine(Root, "exports");
  Directory.CreateDirectory(Root); PrivateDirectory(Root);
  if (File.Exists(marker)) {
   CheckAncestors(marker);
   if (new FileInfo(marker).Length > 128 || File.ReadAllText(marker, Encoding.UTF8) != MarkerText) throw InvalidState();
  } else {
   if (File.Exists(session) || profiles.Any(Directory.Exists)) throw InvalidState();
   WriteNew(marker, Encoding.UTF8.GetBytes(MarkerText), CancellationToken.None);
  }
 }
 internal bool Exists { get { CheckAncestors(session); return File.Exists(session); } }
 internal IDisposable Acquire() {
  string filename = Path.Combine(Root, ".youtube-operation.lock"); CheckAncestors(filename);
  try { return new FileStream(filename, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
  catch (IOException) { throw new NativeFailure("AUTH_BUSY", "YouTube 连接正在使用中，请稍后重试。"); }
 }
 static NativeFailure InvalidState() { return new NativeFailure("AUTH_STATE_INVALID", "YouTube 连接目录无效，请重新设置连接。"); }
 static string Absolute(string path) {
  if (String.IsNullOrEmpty(path) || path.IndexOfAny(new[] { '\0', '"', '\r', '\n' }) >= 0 || !Path.IsPathRooted(path)) throw InvalidState();
  string full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
  if (String.IsNullOrEmpty(full)) throw InvalidState();
  return full;
 }
 static bool Inside(string root, string filename) {
  return filename.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
 }
 static void CheckAncestors(string path) {
  string current = Path.GetFullPath(path);
  while (!String.IsNullOrEmpty(current)) {
   if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw InvalidState();
   string parent = Path.GetDirectoryName(current); if (parent == current) break; current = parent;
  }
 }
 static void PrivateDirectory(string directory) {
  CheckAncestors(directory);
  if (!User.Equals(Directory.GetAccessControl(directory, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)))) throw PrivateFailure();
  var security = Directory.GetAccessControl(directory, AccessControlSections.Access); security.SetAccessRuleProtection(true, false);
  foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier))) security.RemoveAccessRuleSpecific(rule);
  security.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
  Directory.SetAccessControl(directory, security);
  if (!User.Equals(Directory.GetAccessControl(directory, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)))) throw PrivateFailure();
 }
 static void PrivateFile(string filename) {
  if (!User.Equals(File.GetAccessControl(filename, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)))) throw PrivateFailure();
  var security = File.GetAccessControl(filename, AccessControlSections.Access); security.SetAccessRuleProtection(true, false);
  foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier))) security.RemoveAccessRuleSpecific(rule);
  security.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl, AccessControlType.Allow)); File.SetAccessControl(filename, security);
  if (!User.Equals(File.GetAccessControl(filename, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)))) throw PrivateFailure();
 }
 static NativeFailure PrivateFailure() { return new NativeFailure("AUTH_STATE_PRIVATE_FAILED", "无法确认 YouTube 连接目录仅由当前用户访问，请重新设置连接。"); }
 static void WriteNew(string filename, byte[] bytes, CancellationToken token) {
  CheckAncestors(filename); token.ThrowIfCancellationRequested(); bool created = false;
  try {
   using (var output = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
    created = true; PrivateFile(filename); token.ThrowIfCancellationRequested(); output.Write(bytes, 0, bytes.Length); output.Flush(true);
   }
   token.ThrowIfCancellationRequested();
  } catch { if (created) { try { File.Delete(filename); } catch { } } throw; }
 }
 static byte[] Validated(string[] lines) {
  if (lines == null || lines.Length > 10000) throw Expired();
  var valid = new List<string>(); long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
  foreach (string line in lines) {
   if (String.IsNullOrWhiteSpace(line) || (line.StartsWith("#", StringComparison.Ordinal) && !line.StartsWith("#HttpOnly_", StringComparison.Ordinal))) continue;
   if (line.Any(c => c == '\r' || c == '\n' || c == '\0' || (Char.IsControl(c) && c != '\t'))) throw Expired();
   string[] fields = line.Split('\t'); long expiry;
   if (fields.Length != 7 || fields[5].Length == 0 || !fields[2].StartsWith("/", StringComparison.Ordinal) ||
       (fields[1] != "TRUE" && fields[1] != "FALSE") || (fields[3] != "TRUE" && fields[3] != "FALSE") ||
       !Int64.TryParse(fields[4], NumberStyles.None, CultureInfo.InvariantCulture, out expiry)) throw Expired();
   string domain = fields[0].StartsWith("#HttpOnly_", StringComparison.Ordinal) ? fields[0].Substring(10) : fields[0];
   if (!YouTubeConnection.AllowedCookieDomain(domain) || domain.Contains("..")) throw Expired();
   if (expiry != 0 && expiry <= now) continue;
   valid.Add(line);
  }
  if (!YouTubeConnection.HasYouTubeLogin(valid)) throw Expired();
  byte[] bytes = new UTF8Encoding(false, true).GetBytes("# Netscape HTTP Cookie File\n" + String.Join("\n", valid) + "\n");
  if (bytes.Length > MaxSessionBytes) throw Expired();
  return bytes;
 }
 static NativeFailure Expired() { return new NativeFailure("AUTH_EXPIRED", "YouTube 登录会话已失效，请重新连接。"); }
 internal void Save(string[] lines, CancellationToken token) {
  byte[] plain = Validated(lines), cipher = null; string pending = session + "." + Guid.NewGuid().ToString("N") + ".new";
  try {
   token.ThrowIfCancellationRequested(); cipher = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser);
   WriteNew(pending, cipher, token); CheckAncestors(session); token.ThrowIfCancellationRequested();
   if (File.Exists(session)) File.Replace(pending, session, null); else File.Move(pending, session);
  } finally { Array.Clear(plain, 0, plain.Length); if (cipher != null) Array.Clear(cipher, 0, cipher.Length); if (File.Exists(pending)) File.Delete(pending); }
 }
 internal byte[] Read(CancellationToken token) {
  token.ThrowIfCancellationRequested(); CheckAncestors(session);
  if (!File.Exists(session)) throw new NativeFailure("AUTH_REQUIRED", "请先连接 YouTube 登录会话。");
  if (new FileInfo(session).Length < 1 || new FileInfo(session).Length > MaxSessionBytes + 65536) throw Expired();
  byte[] cipher = File.ReadAllBytes(session), plain = null;
  try {
   plain = ProtectedData.Unprotect(cipher, null, DataProtectionScope.CurrentUser); token.ThrowIfCancellationRequested();
   return Validated(new UTF8Encoding(false, true).GetString(plain).Split('\n'));
  } catch (DecoderFallbackException) { throw Expired(); }
  finally { Array.Clear(cipher, 0, cipher.Length); if (plain != null) Array.Clear(plain, 0, plain.Length); }
 }
 string ExportTarget(string output) {
  string target = Absolute(output), directory = Path.GetDirectoryName(target); Guid id;
  if (!Inside(exports, target) || Path.GetFileName(target) != "cookies.txt" ||
      !String.Equals(Path.GetDirectoryName(directory), exports, StringComparison.OrdinalIgnoreCase) ||
      !(Guid.TryParseExact(Path.GetFileName(directory), "N", out id) || Guid.TryParseExact(Path.GetFileName(directory), "D", out id))) throw InvalidState();
  CheckAncestors(target); return target;
 }
 void WriteExport(string target, byte[] plain, CancellationToken token) {
  string directory = Path.GetDirectoryName(target);
  Directory.CreateDirectory(exports); PrivateDirectory(exports); Directory.CreateDirectory(directory); PrivateDirectory(directory);
  WriteNew(target, plain, token);
 }
 internal void Export(string output, CancellationToken token) {
  string target = ExportTarget(output); byte[] plain = Read(token);
  try {
   WriteExport(target, plain, token);
  } finally { Array.Clear(plain, 0, plain.Length); }
 }
 static NativeFailure InvalidBrowserSession() { return new NativeFailure("AUTH_BROWSER_SESSION_INVALID", "当前 Chrome 登录信息无效，请刷新原视频页面后重试。"); }
 static string CookieText(Dictionary<string,object> cookie, string field, int maximum, bool empty) {
  object raw; if (!cookie.TryGetValue(field, out raw) || !(raw is string)) throw InvalidBrowserSession();
  string value = (string)raw;
  if ((!empty && value.Length == 0) || value.Length > maximum || value.Any(Char.IsControl)) throw InvalidBrowserSession();
  return value;
 }
 static bool CookieFlag(Dictionary<string,object> cookie, string field) {
  object raw; if (!cookie.TryGetValue(field, out raw) || !(raw is bool)) throw InvalidBrowserSession(); return (bool)raw;
 }
 static double SessionNumber(object raw) {
  if (!(raw is int) && !(raw is long) && !(raw is double) && !(raw is decimal)) throw InvalidBrowserSession();
  double value = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
  if (Double.IsNaN(value) || Double.IsInfinity(value)) throw InvalidBrowserSession(); return value;
 }
 static byte[] BrowserSession(string site, Stream input, CancellationToken token) {
  if (site != "youtube" && site != "bilibili") throw InvalidBrowserSession();
  byte[] buffer = new byte[MaxBrowserSessionBytes + 1]; int length = 0;
  Dictionary<string,object> data;
  try {
   while (length < buffer.Length) { token.ThrowIfCancellationRequested(); int count = input.Read(buffer, length, buffer.Length - length); if (count == 0) break; length += count; }
   if (length == 0 || length > MaxBrowserSessionBytes) throw InvalidBrowserSession();
   try { data = new JavaScriptSerializer { MaxJsonLength = MaxBrowserSessionBytes, RecursionLimit = 8 }.DeserializeObject(new UTF8Encoding(false, true).GetString(buffer, 0, length)) as Dictionary<string,object>; }
   catch (Exception error) { if (error is OperationCanceledException) throw; throw InvalidBrowserSession(); }
  } finally { Array.Clear(buffer, 0, buffer.Length); }
  if (data == null || data.Count != 2 || !data.ContainsKey("capturedAt") || !data.ContainsKey("cookies")) throw InvalidBrowserSession();
  double capturedAt = SessionNumber(data["capturedAt"]), now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
  if (capturedAt != Math.Floor(capturedAt) || capturedAt <= 0 || capturedAt - now > 30000 || now - capturedAt > 120000)
   throw new NativeFailure("AUTH_BROWSER_SESSION_EXPIRED", "当前 Chrome 登录信息已过期，请重新发起下载。");
  object[] cookies = data["cookies"] as object[];
  if (cookies == null || cookies.Length > 512) throw InvalidBrowserSession();
  var fields = new HashSet<string>(new[] { "domain", "path", "name", "value", "secure", "httpOnly", "session", "hostOnly", "expirationDate", "sameSite", "storeId", "partitionKey", "partitionKeyOpaque" }, StringComparer.Ordinal);
  var identities = new HashSet<string>(StringComparer.Ordinal); var lines = new List<string>(); bool hasBilibiliLogin = false;
  foreach (object raw in cookies) {
   token.ThrowIfCancellationRequested(); var cookie = raw as Dictionary<string,object>;
   if (cookie == null || cookie.Keys.Any(field => !fields.Contains(field))) throw InvalidBrowserSession();
   if (cookie.ContainsKey("partitionKey") || cookie.ContainsKey("partitionKeyOpaque") && (!(cookie["partitionKeyOpaque"] is bool) || (bool)cookie["partitionKeyOpaque"])) throw InvalidBrowserSession();
   string domain = CookieText(cookie, "domain", 253, false).ToLowerInvariant();
   string host = domain.StartsWith(".", StringComparison.Ordinal) ? domain.Substring(1) : domain;
   string suffix = site == "youtube" ? @"youtube\.com\z" : @"bilibili\.com\z";
   if (!Regex.IsMatch(host, @"\A(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*" + suffix, RegexOptions.CultureInvariant)) throw InvalidBrowserSession();
   string path = CookieText(cookie, "path", 4096, false), name = CookieText(cookie, "name", 256, false), value = CookieText(cookie, "value", 65536, true);
   if (!path.StartsWith("/", StringComparison.Ordinal) || !Regex.IsMatch(name, @"\A[!#$%&'*+\-.^_`|~0-9A-Za-z]+\z", RegexOptions.CultureInvariant)) throw InvalidBrowserSession();
   bool secure = CookieFlag(cookie, "secure"), httpOnly = CookieFlag(cookie, "httpOnly"), sessionCookie = CookieFlag(cookie, "session"), hostOnly = CookieFlag(cookie, "hostOnly");
   if (hostOnly == domain.StartsWith(".", StringComparison.Ordinal)) throw InvalidBrowserSession();
   if (cookie.ContainsKey("sameSite") && !new[] { "no_restriction", "lax", "strict", "unspecified" }.Contains(CookieText(cookie, "sameSite", 20, false))) throw InvalidBrowserSession();
   if (cookie.ContainsKey("storeId")) CookieText(cookie, "storeId", 64, false);
   long expiry = 0;
   if (!sessionCookie) {
    object expiration; if (!cookie.TryGetValue("expirationDate", out expiration)) throw InvalidBrowserSession();
    double seconds = SessionNumber(expiration); if (seconds <= 0 || seconds > 253402300799) throw InvalidBrowserSession();
    expiry = (long)Math.Floor(seconds); if (expiry <= Math.Floor(now / 1000)) continue;
   } else if (cookie.ContainsKey("expirationDate")) throw InvalidBrowserSession();
   if (!identities.Add(domain + "\t" + path + "\t" + name)) throw InvalidBrowserSession();
   if (site == "bilibili" && name == "SESSDATA" && !String.IsNullOrEmpty(value)) hasBilibiliLogin = true;
   lines.Add((httpOnly ? "#HttpOnly_" : "") + domain + "\t" + (!hostOnly ? "TRUE" : "FALSE") + "\t" + path + "\t" + (secure ? "TRUE" : "FALSE") + "\t" + expiry.ToString(CultureInfo.InvariantCulture) + "\t" + name + "\t" + value);
  }
  if (site == "youtube" ? !YouTubeConnection.HasYouTubeLogin(lines) : !hasBilibiliLogin)
   throw new NativeFailure("AUTH_BROWSER_LOGIN_REQUIRED", "当前 Chrome 尚未登录 " + (site == "youtube" ? "YouTube" : "Bilibili") + "，请在该浏览器中登录后重试。");
  byte[] result = new UTF8Encoding(false, true).GetBytes("# Netscape HTTP Cookie File\n" + String.Join("\n", lines) + "\n");
  if (result.Length > MaxBrowserSessionBytes) { Array.Clear(result, 0, result.Length); throw InvalidBrowserSession(); }
  return result;
 }
 internal void ExportBrowserSession(string site, string output, Stream input, CancellationToken token) {
  string target = ExportTarget(output); byte[] plain = BrowserSession(site, input, token);
  try { WriteExport(target, plain, token); }
  finally { Array.Clear(plain, 0, plain.Length); }
 }
 internal void Disconnect(CancellationToken token) {
  // Check every legacy/current dedicated profile before deleting any of them.
  // Chrome and Edge must never share profile data or leave an active session behind.
  foreach (string profile in profiles) {
   token.ThrowIfCancellationRequested(); CheckAncestors(profile); EnsureNoRunningProfile(profile);
   if (!Directory.Exists(profile)) continue;
   using (var lease = new FileStream(Path.Combine(profile, ".downloader-connection.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) { }
   CheckTree(profile);
  }
  foreach (string profile in profiles) { token.ThrowIfCancellationRequested(); if (Directory.Exists(profile)) Directory.Delete(profile, true); }
  CheckAncestors(session); token.ThrowIfCancellationRequested(); if (File.Exists(session)) File.Delete(session);
 }
 static void CheckTree(string directory) {
  CheckAncestors(directory);
  foreach (string entry in Directory.GetFileSystemEntries(directory)) {
   var attributes = File.GetAttributes(entry); if ((attributes & FileAttributes.ReparsePoint) != 0) throw InvalidState();
   if ((attributes & FileAttributes.Directory) != 0) CheckTree(entry);
  }
 }
 internal static void RecordBrowser(string profile, Process browser) {
  string filename = Path.Combine(profile, ".mosaic-browser-owner.json"); CheckAncestors(filename);
  var json = new JavaScriptSerializer().Serialize(new { pid = browser.Id, started = browser.StartTime.ToUniversalTime().Ticks });
  if (File.Exists(filename)) File.Delete(filename);
  WriteNew(filename, Encoding.UTF8.GetBytes(json), CancellationToken.None);
 }
 internal static void EnsureNoRunningProfile(string profile) {
  CheckAncestors(profile); if (!Directory.Exists(profile)) return;
  string owner = Path.Combine(profile, ".mosaic-browser-owner.json"), port = Path.Combine(profile, "DevToolsActivePort");
  CheckAncestors(owner); CheckAncestors(port);
  if (File.Exists(owner)) {
   try {
    if (new FileInfo(owner).Length > 1024) throw InvalidState();
    var data = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(owner));
    int pid = Convert.ToInt32(data["pid"], CultureInfo.InvariantCulture); long started = Convert.ToInt64(data["started"], CultureInfo.InvariantCulture);
    try { using (var process = Process.GetProcessById(pid)) if (!process.HasExited && process.StartTime.ToUniversalTime().Ticks == started) throw new NativeFailure("AUTH_BUSY", "YouTube 专用登录窗口仍在运行，请先关闭该窗口。"); }
    catch (ArgumentException) { }
   } catch (NativeFailure) { throw; } catch { throw InvalidState(); }
  }
  if (File.Exists(port)) {
   if (new FileInfo(port).Length > 1024) throw InvalidState();
   var lines = File.ReadAllLines(port); int number; Guid id;
   if (lines.Length != 2 || !Int32.TryParse(lines[0], NumberStyles.None, CultureInfo.InvariantCulture, out number) || number < 1 || number > 65535 ||
       !lines[1].StartsWith("/devtools/browser/", StringComparison.Ordinal) || !Guid.TryParseExact(lines[1].Substring(18), "D", out id)) throw InvalidState();
   if (System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(endpoint => endpoint.Port == number))
    throw new NativeFailure("AUTH_BUSY", "YouTube 专用登录窗口仍在运行，请先关闭该窗口。");
  }
 }
 internal void SelfTest(CancellationToken token) {
  string scratch = Path.Combine(Root, "self-test-" + Guid.NewGuid().ToString("N"));
  try {
   var state = new NativeState(scratch);
   string[] dummy = { "# Netscape HTTP Cookie File", ".youtube.com\tTRUE\t/\tTRUE\t4102444800\tSID\tmosaic-fixed-dummy-not-a-real-login" };
   state.Save(dummy, token); string target = Path.Combine(scratch, "exports", Guid.NewGuid().ToString("N"), "cookies.txt"); state.Export(target, token);
   byte[] expected = Validated(dummy), actual = File.ReadAllBytes(target), encrypted = File.ReadAllBytes(state.session);
   try {
    if (!actual.SequenceEqual(expected) || encrypted.SequenceEqual(expected)) throw new NativeFailure("AUTH_SELF_TEST_FAILED", "YouTube 连接组件自检失败。");
    var rules = File.GetAccessControl(target).GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>();
    if (rules.Any(rule => rule.AccessControlType == AccessControlType.Allow && !User.Equals(rule.IdentityReference))) throw InvalidState();
   } finally { Array.Clear(expected, 0, expected.Length); Array.Clear(actual, 0, actual.Length); Array.Clear(encrypted, 0, encrypted.Length); }
  } finally { if (Directory.Exists(scratch)) { CheckTree(scratch); Directory.Delete(scratch, true); } }
 }
}
