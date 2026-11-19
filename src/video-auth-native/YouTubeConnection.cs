// Adapted from the user-provided 2026-10-13 bang installer payload/YouTubeConnection.cs.
// Only a Mosaic-owned Chrome or Edge profile is opened; existing browser profiles are never inspected.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.WebSockets;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

// This connection uses only a newly launched browser instance and this application's own profile.
// No scripts are injected and no login fields, authentication requests or browser databases are read.
internal static class YouTubeConnection {
 static int connecting;
 static readonly string[] CookieUrls={"https://www.youtube.com/","https://youtube.com/","https://m.youtube.com/","https://accounts.google.com/","https://www.google.com/","https://google.com/","https://googlevideo.com/"};
 static readonly string[] LoginNames={"SID","__Secure-1PSID","__Secure-3PSID","LOGIN_INFO"};
 internal sealed class BrowserChoice {
  internal readonly string Name,Executable,ProfileName;
  internal BrowserChoice(string name,string executable,string profileName){Name=name;Executable=executable;ProfileName=profileName;}
  internal string ProfileDirectory(string stateDir){return Path.Combine(Path.GetFullPath(stateDir),ProfileName);}
 }
 internal static BrowserChoice SelectBrowser(Func<string,bool> exists,Func<Environment.SpecialFolder,string> folder){
  foreach(var browser in new[]{new[]{"Google Chrome","Google","Chrome","chrome.exe","youtube-profile-chrome"},new[]{"Microsoft Edge","Microsoft","Edge","msedge.exe","youtube-profile-edge"}}){
   foreach(var root in new[]{Environment.SpecialFolder.ProgramFiles,Environment.SpecialFolder.ProgramFilesX86,Environment.SpecialFolder.LocalApplicationData}){
    string directory=folder(root);if(String.IsNullOrWhiteSpace(directory))continue;
    string executable=Path.Combine(directory,browser[1],browser[2],"Application",browser[3]);
    if(exists(executable))return new BrowserChoice(browser[0],executable,browser[4]);
   }
  }
  throw new FileNotFoundException("未找到 Google Chrome 或 Microsoft Edge。请安装 Google Chrome 后再连接 YouTube。");
 }
 static BrowserChoice FindBrowser(){return SelectBrowser(File.Exists,Environment.GetFolderPath);}
 internal static async Task<string[]> ConnectAsync(Window owner,string stateDir,string videoUrl,CancellationToken cancellation){
  if(Interlocked.CompareExchange(ref connecting,1,0)!=0)throw new InvalidOperationException("YouTube 连接窗口已经打开，请先完成或取消当前连接。");
  ConnectionWindow prompt=null;ConnectionSession session=null;bool ownerWasEnabled=owner!=null&&owner.IsEnabled;
  using(var lifetime=CancellationTokenSource.CreateLinkedTokenSource(cancellation)){ lifetime.CancelAfter(TimeSpan.FromMinutes(15));
   try{
    string[] result=null;Exception failure=null;bool closed=true;
    try{
     var choice=FindBrowser();
     prompt=new ConnectionWindow(lifetime,choice.Name);if(owner!=null){prompt.Owner=owner;owner.IsEnabled=false;}
     prompt.Show();session=new ConnectionSession(choice.ProfileDirectory(stateDir),choice);
     await session.StartAsync(SafeVideoUrl(videoUrl),lifetime.Token);
     prompt.Ready("在新打开的 "+choice.Name+" 专用窗口中登录 YouTube，并打开要下载的视频。然后回到这里继续。");
     while(true){
      bool accepted=await prompt.WaitContinueAsync(lifetime.Token);
      if(!accepted)throw new InvalidOperationException("Google 拒绝了这次浏览器登录，连接已停止。请保持 Google 的安全设置；此方式暂时无法为该账号建立连接。");
      prompt.Working("正在保存你的 YouTube 连接…");
      var cookies=await session.ReadCookiesAsync(lifetime.Token);
      var lines=ToNetscape(cookies);
      if(HasYouTubeLogin(lines)){result=lines;break;}
      prompt.Ready("尚未检测到有效的 YouTube 登录。请在刚打开的 "+choice.Name+" 专用窗口中完成登录，确认 YouTube 已显示你的头像后重试。");
     }
    }catch(Exception ex){failure=ex;}
    if(prompt!=null)prompt.Working("正在关闭本次连接窗口…");
    if(session!=null){try{closed=await session.CloseAsync();}catch(Exception){closed=false;}}
    if(!closed)throw new NativeFailure("AUTH_CONNECT_FAILED","本次 "+session.BrowserName+" 连接窗口未能自动关闭，请手动关闭该专用窗口后再试。日常浏览器没有被关闭。");
    if(failure!=null){ExceptionDispatchInfo.Capture(failure).Throw();}
    return result;
   }finally{
    if(session!=null)session.Dispose();if(prompt!=null)prompt.Finish();if(owner!=null&&ownerWasEnabled)owner.IsEnabled=true;Interlocked.Exchange(ref connecting,0);
   }
  }
 }

 static string SafeVideoUrl(string value){
  Uri uri;if(Uri.TryCreate(value,UriKind.Absolute,out uri)&&(uri.Scheme=="http"||uri.Scheme=="https")&&string.IsNullOrEmpty(uri.UserInfo)&&IsDomain(uri.Host,"youtube.com"))return new UriBuilder(uri){Scheme="https",Port=-1}.Uri.AbsoluteUri;
  if(Uri.TryCreate(value,UriKind.Absolute,out uri)&&(uri.Scheme=="http"||uri.Scheme=="https")&&string.IsNullOrEmpty(uri.UserInfo)&&uri.Host.Equals("youtu.be",StringComparison.OrdinalIgnoreCase))return new UriBuilder(uri){Scheme="https",Port=-1}.Uri.AbsoluteUri;
  return "https://www.youtube.com/";
 }
 static bool IsDomain(string host,string root){return host.Equals(root,StringComparison.OrdinalIgnoreCase)||host.EndsWith("."+root,StringComparison.OrdinalIgnoreCase);}
 internal static bool AllowedCookieDomain(string domain){if(string.IsNullOrEmpty(domain))return false;string d=domain[0]=='.'?domain.Substring(1):domain;return Uri.CheckHostName(d)==UriHostNameType.Dns&&(IsDomain(d,"youtube.com")||IsDomain(d,"google.com")||IsDomain(d,"googlevideo.com"));}
 static string Text(Dictionary<string,object> value,string key){object item;return value.TryGetValue(key,out item)&&item!=null?Convert.ToString(item,CultureInfo.InvariantCulture):"";}
 static bool Flag(Dictionary<string,object> value,string key){object item;return value.TryGetValue(key,out item)&&item is bool&&(bool)item;}
 static bool SafeField(string value){return !value.Any(c=>c=='\t'||c=='\r'||c=='\n'||c=='\0'||char.IsControl(c));}
 internal static string[] ToNetscape(IEnumerable<Dictionary<string,object>> cookies){
  var output=new SortedDictionary<string,string>(StringComparer.Ordinal);double now=(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalSeconds;
  foreach(var cookie in cookies){
   if(cookie==null||cookie.ContainsKey("partitionKey")||Flag(cookie,"partitionKeyOpaque"))continue;
   string domain=Text(cookie,"domain").ToLowerInvariant(),path=Text(cookie,"path"),name=Text(cookie,"name"),value=Text(cookie,"value");
   if(!AllowedCookieDomain(domain)||name.Length==0||!SafeField(domain)||!SafeField(path)||!SafeField(name)||!SafeField(value))continue;
   if(path.Length==0)path="/";if(!path.StartsWith("/",StringComparison.Ordinal))continue;
   double expires;bool hasExpiry=double.TryParse(Text(cookie,"expires"),NumberStyles.Float,CultureInfo.InvariantCulture,out expires);
   bool isSession=Flag(cookie,"session")||(hasExpiry&&expires<0);long expiration=0;
   if(!isSession){if(!hasExpiry||double.IsNaN(expires)||double.IsInfinity(expires)||expires<=now||expires>=long.MaxValue)continue;expiration=(long)Math.Floor(expires);}
   string line=(Flag(cookie,"httpOnly")?"#HttpOnly_":"")+domain+"\t"+(domain.StartsWith(".",StringComparison.Ordinal)?"TRUE":"FALSE")+"\t"+path+"\t"+(Flag(cookie,"secure")?"TRUE":"FALSE")+"\t"+expiration.ToString(CultureInfo.InvariantCulture)+"\t"+name+"\t"+value;
   output[domain+"\t"+path+"\t"+name]=line;
  }
  return new[]{"# Netscape HTTP Cookie File"}.Concat(output.Values).ToArray();
 }
 internal static bool HasYouTubeLogin(IEnumerable<string> lines){
  foreach(string line in lines){string[] fields=line.Split('\t');if(fields.Length!=7)continue;string domain=fields[0].Replace("#HttpOnly_","").TrimStart('.');if(IsDomain(domain,"youtube.com")&&LoginNames.Contains(fields[5])&&!string.IsNullOrEmpty(fields[6]))return true;}return false;
 }

 // A test-only entry point. It creates a new empty profile, visits about:blank and never requests cookies.
 internal static async Task<string> SmokeAsync(string scratchDirectory){
  string profile=Path.Combine(Path.GetFullPath(scratchDirectory),"YouTubeBlankSmoke-"+Guid.NewGuid().ToString("N"));
  var choice=FindBrowser();var session=new ConnectionSession(profile,choice);Exception failure=null;bool closed=false;int port=0;
  try{using(var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(35))){await session.StartAsync("about:blank",timeout.Token,true);port=session.Port;await session.VerifyBlankAsync(timeout.Token);}}
  catch(Exception ex){failure=ex;}
  try{closed=await session.CloseAsync();}finally{session.Dispose();}
  if(failure!=null)ExceptionDispatchInfo.Capture(failure).Throw();if(!closed)throw new IOException("Blank-profile browser did not close.");
  return "Blank profile verified; loopback endpoint owned by launched "+choice.Name+"; browser closed; port "+port+" released. No cookies requested.";
 }

 sealed class ConnectionWindow:Window {
  readonly CancellationTokenSource lifetime;readonly TextBlock status;readonly Button proceed,rejected,cancel;TaskCompletionSource<bool> pending;bool finishing;
  internal ConnectionWindow(CancellationTokenSource cancellation,string browserName){
   lifetime=cancellation;Title="Mosaic · "+browserName;Width=510;Height=320;ResizeMode=ResizeMode.NoResize;WindowStartupLocation=WindowStartupLocation.CenterScreen;ShowInTaskbar=true;
   Background=new SolidColorBrush(Color.FromRgb(235,243,251));Foreground=new SolidColorBrush(Color.FromRgb(44,63,86));FontFamily=new FontFamily("Microsoft YaHei UI");FontSize=13;
   var panel=new StackPanel{Margin=new Thickness(26)};Content=panel;
   panel.Children.Add(new TextBlock{Text="完成登录，继续读取",FontSize=22,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,14)});
   status=new TextBlock{Text="正在打开 "+browserName+" 专用 YouTube 登录窗口…",TextWrapping=TextWrapping.Wrap,Height=90,LineHeight=23};panel.Children.Add(status);
   panel.Children.Add(new TextBlock{Text="请在专用窗口中登录；日常浏览器可以保持打开。",FontSize=12,Opacity=.75,Margin=new Thickness(0,8,0,18)});
   var buttons=new StackPanel{Orientation=Orientation.Horizontal,HorizontalAlignment=HorizontalAlignment.Right};panel.Children.Add(buttons);
   cancel=MakeButton("取消",65);rejected=MakeButton("登录被拒绝",100);proceed=MakeButton("已完成登录，继续",152);buttons.Children.Add(cancel);buttons.Children.Add(rejected);buttons.Children.Add(proceed);proceed.IsEnabled=false;rejected.IsEnabled=false;
   cancel.Click+=(s,e)=>Cancel();rejected.Click+=(s,e)=>Choose(false);proceed.Click+=(s,e)=>Choose(true);
   Closing+=(s,e)=>{if(!finishing){e.Cancel=true;Cancel();}};
  }
  Button MakeButton(string label,double width){return new Button{Content=label,Width=width,Height=36,Margin=new Thickness(6,0,0,0),Padding=new Thickness(4),Background=new SolidColorBrush(Color.FromRgb(215,230,246)),BorderBrush=new SolidColorBrush(Color.FromRgb(167,190,216))};}
  void Cancel(){lifetime.Cancel();if(pending!=null)pending.TrySetCanceled();Working("正在取消连接…");}
  void Choose(bool accepted){if(pending==null)return;proceed.IsEnabled=false;rejected.IsEnabled=false;pending.TrySetResult(accepted);}
  internal void Working(string message){status.Text=message;proceed.IsEnabled=false;rejected.IsEnabled=false;}
  internal void Ready(string message){status.Text=message;}
  internal async Task<bool> WaitContinueAsync(CancellationToken token){pending=new TaskCompletionSource<bool>();proceed.IsEnabled=true;rejected.IsEnabled=true;using(token.Register(()=>pending.TrySetCanceled())){return await pending.Task;}}
  internal void Finish(){finishing=true;Close();}
 }

 sealed class ConnectionSession:IDisposable {
  readonly string profile,portFile;readonly BrowserChoice choice;Process browser;FileStream profileLease;DateTime launched;string endpointPath;int port;
  internal int Port {get{return port;}}
  internal string BrowserName {get{return choice.Name;}}
  internal ConnectionSession(string path,BrowserChoice browserChoice){profile=Path.GetFullPath(path);portFile=Path.Combine(profile,"DevToolsActivePort");choice=browserChoice;}
  static string Quote(string value){if(value.IndexOf('"')>=0)throw new ArgumentException("路径包含无效字符。");return "\""+value.TrimEnd('\\')+"\"";}
  internal async Task StartAsync(string url,CancellationToken token,bool hiddenSmoke=false){
   token.ThrowIfCancellationRequested();NativeState.EnsureNoRunningProfile(profile);Directory.CreateDirectory(profile);
   try{profileLease=new FileStream(Path.Combine(profile,".downloader-connection.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);}catch(IOException){throw new IOException("YouTube 连接已在另一个软件窗口中打开，请先完成或取消该连接。");}
   if(File.Exists(portFile)){int oldPort;string oldPath;if(TryReadPort(out oldPort,out oldPath)&&IsListening(oldPort))throw new IOException("专用 YouTube 浏览器仍在运行，请关闭该连接窗口后重试。你的日常浏览器无需关闭。");File.Delete(portFile);}
   launched=DateTime.UtcNow;
   try{browser=Process.Start(new ProcessStartInfo(choice.Executable,"--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --user-data-dir="+Quote(profile)+" --no-first-run --no-default-browser-check --new-window "+Quote(url)){UseShellExecute=false,WindowStyle=hiddenSmoke?ProcessWindowStyle.Hidden:ProcessWindowStyle.Normal,RedirectStandardOutput=true,RedirectStandardError=true});}
   catch(System.ComponentModel.Win32Exception){throw new NativeFailure("AUTH_CONNECT_FAILED","无法启动 "+choice.Name+" 专用 YouTube 窗口，请安装或修复该浏览器后重试。");}
   if(browser==null)throw new NativeFailure("AUTH_CONNECT_FAILED","未能打开 "+choice.Name+" 专用 YouTube 窗口。"); NativeState.RecordBrowser(profile,browser);
   // Browsers may print a debugging endpoint or website diagnostics; drain both pipes without logging their contents.
   browser.OutputDataReceived+=(s,e)=>{};browser.ErrorDataReceived+=(s,e)=>{};browser.BeginOutputReadLine();browser.BeginErrorReadLine();
   DateTime deadline=DateTime.UtcNow.AddSeconds(25);
   while(DateTime.UtcNow<deadline){token.ThrowIfCancellationRequested();if(TryCaptureEndpoint()){await VerifyEndpointAsync(token);return;}if(browser.HasExited)throw new NativeFailure("AUTH_CONNECT_FAILED",choice.Name+" 专用 YouTube 窗口已退出，请重试。");await Task.Delay(180,token);}
   throw new NativeFailure("AUTH_CONNECT_FAILED",choice.Name+" 启动超时，请关闭刚打开的 YouTube 专用窗口后重试。");
  }
  bool TryReadPort(out int readPort,out string path){readPort=0;path=null;try{string[] lines=File.ReadAllLines(portFile);Guid id;if(lines.Length<2||!int.TryParse(lines[0],NumberStyles.None,CultureInfo.InvariantCulture,out readPort)||readPort<1||readPort>65535||!lines[1].StartsWith("/devtools/browser/",StringComparison.Ordinal)||!Guid.TryParseExact(lines[1].Substring("/devtools/browser/".Length),"D",out id))return false;path=lines[1];return true;}catch(IOException){return false;}catch(UnauthorizedAccessException){return false;}}
  bool TryCaptureEndpoint(){int foundPort;string path;if(!TryReadPort(out foundPort,out path)||File.GetLastWriteTimeUtc(portFile)<launched.AddSeconds(-2))return false;port=foundPort;endpointPath=path;EnsureOwnedEndpoint();return true;}
  void EnsureOwnedEndpoint(){
   int filePort;string filePath;if(browser==null||browser.HasExited||!TryReadPort(out filePort,out filePath)||filePort!=port||filePath!=endpointPath)throw new IOException("本次浏览器连接已失效，请重新连接 YouTube。");
   var listeners=IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Where(x=>x.Port==port).ToArray();
   if(listeners.Length==0||listeners.Any(x=>!IPAddress.IsLoopback(x.Address))||ListeningProcess(port)!=browser.Id)throw new IOException("无法确认这是本次专用浏览器的本机连接，已停止读取。");
  }
  async Task VerifyEndpointAsync(CancellationToken token){
   EnsureOwnedEndpoint();using(var timeout=CancellationTokenSource.CreateLinkedTokenSource(token)){timeout.CancelAfter(TimeSpan.FromSeconds(5));using(var handler=new HttpClientHandler{UseProxy=false,AllowAutoRedirect=false})using(var client=new HttpClient(handler))using(var response=await client.GetAsync("http://127.0.0.1:"+port+"/json/version",timeout.Token)){
    if(!response.IsSuccessStatusCode)throw new IOException("专用浏览器连接未就绪，请重试。");string body=await response.Content.ReadAsStringAsync();var version=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(body);Uri socket;
    if(!Uri.TryCreate(Text(version,"webSocketDebuggerUrl"),UriKind.Absolute,out socket)||socket.Scheme!="ws"||socket.Host!="127.0.0.1"||socket.Port!=port||socket.AbsolutePath!=endpointPath||!string.IsNullOrEmpty(socket.Query)||!string.IsNullOrEmpty(socket.Fragment)||!string.IsNullOrEmpty(socket.UserInfo))throw new IOException("专用浏览器端点不匹配，已停止读取。");
   }}
  }
  async Task<CdpSocket> OpenSocketAsync(CancellationToken token){await VerifyEndpointAsync(token);var socket=new CdpSocket();try{await socket.ConnectAsync(new Uri("ws://127.0.0.1:"+port+endpointPath),token);return socket;}catch{socket.Dispose();throw;}}
  internal async Task<List<Dictionary<string,object>>> ReadCookiesAsync(CancellationToken token){
   using(var timeout=CancellationTokenSource.CreateLinkedTokenSource(token)){timeout.CancelAfter(TimeSpan.FromSeconds(15));using(var socket=await OpenSocketAsync(timeout.Token)){
    var targets=await socket.CallAsync("Target.getTargets",null,null,timeout.Token);var pages=Objects(targets,"targetInfos").Where(x=>Text(x,"type")=="page").ToList();
    foreach(var page in pages){Uri pageUri;if(Uri.TryCreate(Text(page,"url"),UriKind.Absolute,out pageUri)&&IsDomain(pageUri.Host,"google.com")&&(pageUri.AbsolutePath.IndexOf("/signin/rejected",StringComparison.OrdinalIgnoreCase)>=0||pageUri.AbsolutePath.IndexOf("/deniedsigninrejected",StringComparison.OrdinalIgnoreCase)>=0))throw new InvalidOperationException("Google 拒绝了这次浏览器登录，连接已停止。请保持 Google 的安全设置；此方式暂时无法为该账号建立连接。");}
    var youtubePage=pages.FirstOrDefault(x=>{Uri u;return Uri.TryCreate(Text(x,"url"),UriKind.Absolute,out u)&&u.Scheme=="https"&&IsDomain(u.Host,"youtube.com");});
    if(youtubePage==null)return new List<Dictionary<string,object>>();
    var attached=await socket.CallAsync("Target.attachToTarget",new Dictionary<string,object>{{"targetId",Text(youtubePage,"targetId")},{"flatten",true}},null,timeout.Token);string sessionId=Text(attached,"sessionId");
    if(string.IsNullOrEmpty(sessionId))throw new IOException("无法读取 YouTube 连接，请重试。");
    var result=await socket.CallAsync("Network.getCookies",new Dictionary<string,object>{{"urls",CookieUrls}},sessionId,timeout.Token);
    await socket.CallAsync("Target.detachFromTarget",new Dictionary<string,object>{{"sessionId",sessionId}},null,timeout.Token);
    return Objects(result,"cookies").ToList();
   }}
  }
  internal async Task VerifyBlankAsync(CancellationToken token){using(var socket=await OpenSocketAsync(token)){var version=await socket.CallAsync("Browser.getVersion",null,null,token);if(string.IsNullOrEmpty(Text(version,"product")))throw new IOException("Missing browser version.");var targets=await socket.CallAsync("Target.getTargets",null,null,token);if(!Objects(targets,"targetInfos").Any(x=>Text(x,"type")=="page"&&Text(x,"url")=="about:blank"))throw new IOException("Blank smoke page missing.");}}
  internal async Task<bool> CloseAsync(){
   if(browser==null)return true;
   using(var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(10))){
    if(port==0){DateTime wait=DateTime.UtcNow.AddSeconds(3);while(!browser.HasExited&&DateTime.UtcNow<wait){try{if(TryCaptureEndpoint())break;}catch(IOException){}await Task.Delay(100);}}
    if(browser.HasExited)return port==0||ListeningProcess(port)!=browser.Id;
    if(port==0)return false;
    try{using(var socket=await OpenSocketAsync(timeout.Token)){await socket.CallAsync("Browser.close",null,null,timeout.Token);}}catch(Exception){/* Browser.close can close its socket before returning a response. Verify actual listener closure below. */}
    DateTime deadline=DateTime.UtcNow.AddSeconds(5);while(DateTime.UtcNow<deadline){if(ListeningProcess(port)!=browser.Id && browser.HasExited)return true;await Task.Delay(100);}
    return false;
   }
  }
  static IEnumerable<Dictionary<string,object>> Objects(Dictionary<string,object> obj,string key){object list;if(!obj.TryGetValue(key,out list)||!(list is IEnumerable))return Enumerable.Empty<Dictionary<string,object>>();return ((IEnumerable)list).Cast<object>().Select(x=>x as Dictionary<string,object>).Where(x=>x!=null);}
  static bool IsListening(int port){return IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(x=>x.Port==port);}
  [DllImport("iphlpapi.dll",SetLastError=true)]static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool order,int family,int tableClass,uint reserved);
  static int ListeningProcess(int wantedPort){
   int size=0;uint first=GetExtendedTcpTable(IntPtr.Zero,ref size,false,2,3,0);if(first!=0&&first!=122)throw new IOException("无法确认本机浏览器连接。");IntPtr memory=Marshal.AllocHGlobal(size);
   try{if(GetExtendedTcpTable(memory,ref size,false,2,3,0)!=0)throw new IOException("无法确认本机浏览器连接。");int count=Marshal.ReadInt32(memory);for(int i=0;i<count;i++){IntPtr row=IntPtr.Add(memory,4+i*24);int rawPort=Marshal.ReadInt32(row,8);int current=((rawPort&255)<<8)|((rawPort>>8)&255);if(current==wantedPort)return Marshal.ReadInt32(row,20);}return -1;}finally{Marshal.FreeHGlobal(memory);}
  }
  public void Dispose(){if(browser!=null)browser.Dispose();if(profileLease!=null)profileLease.Dispose();}
 }

 sealed class CdpSocket:IDisposable {
  readonly ClientWebSocket socket=new ClientWebSocket();int id;
  internal CdpSocket(){socket.Options.Proxy=null;}
  internal Task ConnectAsync(Uri endpoint,CancellationToken token){return socket.ConnectAsync(endpoint,token);}
  internal async Task<Dictionary<string,object>> CallAsync(string method,Dictionary<string,object> parameters,string sessionId,CancellationToken token){
   var serializer=new JavaScriptSerializer{MaxJsonLength=2*1024*1024};int requestId=++id;var request=new Dictionary<string,object>{{"id",requestId},{"method",method}};if(parameters!=null)request["params"]=parameters;if(sessionId!=null)request["sessionId"]=sessionId;
   byte[] bytes=Encoding.UTF8.GetBytes(serializer.Serialize(request));await socket.SendAsync(new ArraySegment<byte>(bytes),WebSocketMessageType.Text,true,token);
   var buffer=new byte[8192];while(true){using(var message=new MemoryStream()){WebSocketReceiveResult received;do{received=await socket.ReceiveAsync(new ArraySegment<byte>(buffer),token);if(received.MessageType==WebSocketMessageType.Close)throw new IOException("专用浏览器连接已关闭。");if(received.MessageType!=WebSocketMessageType.Text||message.Length+received.Count>2*1024*1024)throw new IOException("专用浏览器返回了无效数据。");message.Write(buffer,0,received.Count);}while(!received.EndOfMessage);
    var response=serializer.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(message.ToArray()));object responseId;if(!response.TryGetValue("id",out responseId)||Convert.ToInt32(responseId,CultureInfo.InvariantCulture)!=requestId)continue;
    if(response.ContainsKey("error"))throw new IOException("浏览器暂时无法完成 YouTube 连接，请重试。");object result;if(!response.TryGetValue("result",out result)||!(result is Dictionary<string,object>))throw new IOException("专用浏览器没有返回有效结果。");return (Dictionary<string,object>)result;
   }}
  }
  public void Dispose(){socket.Dispose();}
 }
}
