param(
  [Parameter(Mandatory)][long]$Handle,
  [Parameter(Mandatory)][int]$DragX,
  [Parameter(Mandatory)][int]$DragY
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ShituWindowProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  struct Point { public int X, Y; }

  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetClientRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll", SetLastError = true)] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr window, IntPtr region);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect bounds, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
  [DllImport("gdi32.dll")] static extern int GetRgnBox(IntPtr region, out Rect bounds);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr region);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region, int x, int y);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);

  public static int HitTest(IntPtr window, int x, int y) {
    var position = unchecked((int)((uint)(x & 65535) | (uint)((y & 65535) << 16)));
    IntPtr result;
    if (SendMessageTimeout(window, 0x84, IntPtr.Zero, new IntPtr(position), 2, 750, out result) == IntPtr.Zero) {
      throw new InvalidOperationException("Window hit test timed out");
    }
    return result.ToInt32();
  }

  public static Rect WindowBounds(IntPtr window) {
    Rect bounds;
    if (!GetWindowRect(window, out bounds)) throw new Win32Exception();
    return bounds;
  }

  public static Rect RegionBounds(IntPtr region) {
    Rect bounds;
    if (GetRgnBox(region, out bounds) == 0) throw new InvalidOperationException("Unable to read window region bounds");
    return bounds;
  }

  public static Rect ClientBounds(IntPtr window) {
    Rect bounds;
    var origin = new Point();
    if (!GetClientRect(window, out bounds) || !ClientToScreen(window, ref origin)) throw new Win32Exception();
    return new Rect { Left = origin.X, Top = origin.Y, Right = origin.X + bounds.Right, Bottom = origin.Y + bounds.Bottom };
  }

  public static Rect VisibleBounds(IntPtr window) {
    Rect bounds;
    Marshal.ThrowExceptionForHR(DwmGetWindowAttribute(window, 9, out bounds, Marshal.SizeOf(typeof(Rect))));
    return bounds;
  }

  public static int? DwmCornerPreference(IntPtr window) {
    int preference;
    int result = DwmGetWindowAttribute(window, 33, out preference, 4);
    return result >= 0 ? (int?)preference : null;
  }

  public static int LeftResizePixels(IntPtr window, IntPtr region, Rect bounds, Rect client) {
    int width = 0;
    int y = (client.Top + client.Bottom) / 2;
    for (int x = bounds.Left; x <= client.Left + 2; x++) {
      if ((region == IntPtr.Zero || PtInRegion(region, x - bounds.Left, y - bounds.Top)) && HitTest(window, x, y) == 10) width++;
    }
    return width;
  }

  // Record the first included physical pixel on each row of all four corners.
  public static int[][] CornerInsets(IntPtr region, Rect bounds, Rect client, int length) {
    var insets = new int[4][];
    for (int corner = 0; corner < insets.Length; corner++) {
      bool fromRight = corner == 1 || corner == 2;
      bool fromBottom = corner >= 2;
      insets[corner] = new int[length];
      for (int row = 0; row < length; row++) {
        int y = (fromBottom ? client.Bottom - 1 - row : client.Top + row) - bounds.Top;
        int column = 0;
        for (; column < length; column++) {
          int x = (fromRight ? client.Right - 1 - column : client.Left + column) - bounds.Left;
          if (PtInRegion(region, x, y)) break;
        }
        insets[corner][row] = column;
      }
    }
    return insets;
  }
}
'@

$null = [ShituWindowProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$target = [IntPtr]::new($Handle)
$bounds = [ShituWindowProbe]::WindowBounds($target)
$client = [ShituWindowProbe]::ClientBounds($target)
$width = $bounds.Right - $bounds.Left
$height = $bounds.Bottom - $bounds.Top
$dpi = [ShituWindowProbe]::GetDpiForWindow($target)
if ($dpi -lt 96) { throw 'Unable to read test window DPI' }

$region = [ShituWindowProbe]::CreateRectRgn(0, 0, 0, 0)
if ($region -eq [IntPtr]::Zero) { throw 'Unable to allocate test region' }
try {
  $shape = [ShituWindowProbe]::GetWindowRgn($target, $region)
  $result = @{
    shape = $shape
    dpi = $dpi
    width = $width
    height = $height
    bounds = $bounds
    client = $client
    visible = [ShituWindowProbe]::VisibleBounds($target)
    dwmCornerPreference = [ShituWindowProbe]::DwmCornerPreference($target)
    drag = [ShituWindowProbe]::HitTest($target, $DragX, $DragY)
    leftEdge = [ShituWindowProbe]::HitTest($target, ($bounds.Left + 1), [int](($bounds.Top + $bounds.Bottom) / 2))
    clientLeftEdge = [ShituWindowProbe]::HitTest($target, ($client.Left + 1), [int](($client.Top + $client.Bottom) / 2))
    clientDiagonal = [ShituWindowProbe]::HitTest($target, ($client.Right - 5), ($client.Bottom - 5))
    leftResizePixels = [ShituWindowProbe]::LeftResizePixels($target, $(if ($shape -gt 0) { $region } else { [IntPtr]::Zero }), $bounds, $client)
  }
  if ($shape -gt 0) {
    $relativeClientLeft = $client.Left - $bounds.Left
    $relativeClientMiddle = [int](($client.Top + $client.Bottom) / 2) - $bounds.Top
    $result.regionBounds = [ShituWindowProbe]::RegionBounds($region)
    $result.cornerInsets = [ShituWindowProbe]::CornerInsets($region, $bounds, $client, [int][Math]::Ceiling(24 * $dpi / 96.0))
    $result.clientEdgeInRegion = [ShituWindowProbe]::PtInRegion($region, ($relativeClientLeft + 1), $relativeClientMiddle)
  }
  $result | ConvertTo-Json -Compress -Depth 4
} finally {
  $null = [ShituWindowProbe]::DeleteObject($region)
}
