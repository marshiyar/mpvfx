# Test instrumentation for a disposable GitHub-hosted Windows desktop only.
# Never run this against a developer's desktop or retain a user profile.
param([Parameter(Mandatory=$true)][string]$EvidenceDirectory, [Parameter(Mandatory=$true)][string]$ControlDirectory)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Desktop capture is restricted to disposable GitHub-hosted runners.'
}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
public class DesktopEvidence {
  public class Window {
    public long handle; public uint pid; public string className; public string title;
    public int left; public int top; public int width; public int height;
    public bool appOwned;
  }
  public class Observation {
    public long elapsedMs; public string phase; public string source; public string image;
    public List<Window> windows;
  }
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr data);
  public delegate void EventCallback(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rectangle);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, EventCallback callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rectangle, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  public List<Observation> observations = new List<Observation>();
  public int frames; public long durationMs; public bool eventHookActive; public int sampleIntervalMs = 100;
  public int screenWidth; public int screenHeight;
  public string capturePolicy = "mpvfx-windows-only";
  private string phase = "baseline";
  private Stopwatch clock = new Stopwatch();
  private Window Describe(IntPtr hwnd) {
    var cls = new StringBuilder(256); var title = new StringBuilder(256); uint pid; Rect rect;
    GetClassName(hwnd, cls, cls.Capacity); GetWindowText(hwnd, title, title.Capacity);
    GetWindowThreadProcessId(hwnd, out pid); GetWindowRect(hwnd, out rect);
    bool appOwned=false;
    try { var name=Process.GetProcessById((int)pid).ProcessName; appOwned=String.Equals(name,"MpVFX",StringComparison.OrdinalIgnoreCase) || String.Equals(name,"Setup",StringComparison.OrdinalIgnoreCase) || System.Text.RegularExpressions.Regex.IsMatch(name,@"^MpVFX-\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?-Setup$",System.Text.RegularExpressions.RegexOptions.IgnoreCase); } catch {}
    return new Window { handle=hwnd.ToInt64(), pid=pid, className=cls.ToString(), title=title.ToString(), left=rect.left, top=rect.top, width=rect.right-rect.left, height=rect.bottom-rect.top, appOwned=appOwned };
  }
  private List<Window> Visible() {
    var list = new List<Window>();
    EnumWindows((hwnd, data) => { if (IsWindowVisible(hwnd)) list.Add(Describe(hwnd)); return true; }, IntPtr.Zero);
    return list;
  }
  public void Run(string directory, string control) {
    SetProcessDPIAware(); clock.Start();
    var bounds = SystemInformation.VirtualScreen; screenWidth=bounds.Width; screenHeight=bounds.Height;
    // The image starts with GitHub's own agent terminal open. Minimize that
    // pre-existing runner window before capture; never touch app/helper windows.
    var baseline=Visible();
    foreach(var window in baseline) {
      if(window.className == "CASCADIA_HOSTING_WINDOW_CLASS" && window.title.EndsWith("hosted-compute-agent")) ShowWindow(new IntPtr(window.handle),6);
    }
    observations.Add(new Observation {elapsedMs=clock.ElapsedMilliseconds,phase="baseline",source="baseline",windows=baseline});
    EventCallback callback = (hook, type, hwnd, obj, child, thread, time) => {
      if (hwnd == IntPtr.Zero || obj != 0 || child != 0) return;
      observations.Add(new Observation { elapsedMs=clock.ElapsedMilliseconds, phase=phase, source="window-show-event", windows=new List<Window>{Describe(hwnd)} });
    };
    var eventHook = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, callback, 0, 0, 0);
    eventHookActive=eventHook != IntPtr.Zero;
    long nextFrame=0; string previous=""; uint visibleEditor=0;
    File.WriteAllText(Path.Combine(control,"monitor-ready"), "ready");
    try {
      while (!File.Exists(Path.Combine(control,"monitor-stop")) && clock.Elapsed.TotalMinutes < 20) {
        Application.DoEvents();
        var phaseFile=Path.Combine(control,"phase");
        if (File.Exists(phaseFile)) {
          try {
            using(var stream=new FileStream(phaseFile,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
            using(var reader=new StreamReader(stream)) { var next=reader.ReadToEnd(); if(next.Length>0) phase=next; }
          } catch(IOException) {}
        }
        var windows=Visible();
        var editor=windows.Find(w=>w.className == "Chrome_WidgetWin_1" && w.title == "MpVFX" && !IsIconic(new IntPtr(w.handle)) && w.width >= 800 && w.height >= 500);
        if(editor != null && visibleEditor != editor.pid) {
          visibleEditor=editor.pid;
          File.WriteAllText(Path.Combine(control,"visible-editor"),visibleEditor.ToString());
        }
        var identity=phase + String.Join("|",windows.ConvertAll(w=>w.handle+":"+w.title));
        string filename=null;
        if(clock.ElapsedMilliseconds >= nextFrame) {
          filename=String.Format("desktop-{0:D5}.png",frames++);
          using(var bitmap=new Bitmap(bounds.Width,bounds.Height)) {
            using(var graphics=Graphics.FromImage(bitmap)) {
              graphics.Clear(Color.FromArgb(32,32,32));
              // EnumWindows returns topmost first. Only capture the visible
              // part of an app window; mask unrelated windows above it, while
              // leaving windows behind the app out of the screenshot entirely.
              using(var covered=new Region()) {
                covered.MakeEmpty();
                foreach(var window in windows) {
                  var handle=new IntPtr(window.handle); int cloaked=0; Rect frame;
                  DwmGetWindowAttribute(handle,14,out cloaked,4);
                  if(cloaked != 0 || IsIconic(handle) || window.className == "Progman" || window.className == "WorkerW") continue;
                  // WindowRect includes invisible resize borders. DWM's visible
                  // frame prevents copying wallpaper or neighboring pixels.
                  if(DwmGetWindowAttribute(handle,9,out frame,Marshal.SizeOf(typeof(Rect))) != 0) continue;
                  var screenArea=Rectangle.Intersect(bounds,new Rectangle(frame.left,frame.top,Math.Max(0,frame.right-frame.left),Math.Max(0,frame.bottom-frame.top)));
                  if(screenArea.Width == 0 || screenArea.Height == 0) continue;
                  var area=screenArea; area.Offset(-bounds.Left,-bounds.Top);
                  graphics.SetClip(area); graphics.ExcludeClip(covered);
                  bool console=window.className == "ConsoleWindowClass" || window.className == "CASCADIA_HOSTING_WINDOW_CLASS" || window.className == "VirtualConsoleClass";
                  if(window.appOwned && !console) {
                    // DrawImage honors the GDI+ clip; raw BitBlt/CopyFromScreen
                    // must not be trusted to apply it when obtaining an HDC.
                    using(var pixels=new Bitmap(area.Width,area.Height)) {
                      using(var grab=Graphics.FromImage(pixels)) grab.CopyFromScreen(screenArea.Left,screenArea.Top,0,0,area.Size);
                      graphics.DrawImageUnscaled(pixels,area.Left,area.Top);
                    }
                  }
                  else graphics.FillRectangle(console ? Brushes.DarkRed : Brushes.DimGray,area);
                  covered.Union(area);
                }
                graphics.ResetClip();
              }
            }
            bitmap.Save(Path.Combine(directory,filename),ImageFormat.Png);
          }
          nextFrame=clock.ElapsedMilliseconds+1000;
        }
        if(identity != previous || filename != null) observations.Add(new Observation {elapsedMs=clock.ElapsedMilliseconds,phase=phase,source="poll",image=filename,windows=windows});
        previous=identity;
        System.Threading.Thread.Sleep(sampleIntervalMs);
      }
    } finally { if(eventHook != IntPtr.Zero) UnhookWinEvent(eventHook); GC.KeepAlive(callback); durationMs=clock.ElapsedMilliseconds; }
  }
}
'@
$capture = New-Object DesktopEvidence
try { $capture.Run($EvidenceDirectory, $ControlDirectory) }
finally { $capture | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $EvidenceDirectory 'windows-desktop.json') }
