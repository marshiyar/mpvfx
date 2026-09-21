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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rectangle);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, EventCallback callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  public List<Observation> observations = new List<Observation>();
  public int frames; public long durationMs; public bool eventHookActive; public int sampleIntervalMs = 100;
  public int screenWidth; public int screenHeight;
  private string phase = "baseline";
  private Stopwatch clock = new Stopwatch();
  private Window Describe(IntPtr hwnd) {
    var cls = new StringBuilder(256); var title = new StringBuilder(256); uint pid; Rect rect;
    GetClassName(hwnd, cls, cls.Capacity); GetWindowText(hwnd, title, title.Capacity);
    GetWindowThreadProcessId(hwnd, out pid); GetWindowRect(hwnd, out rect);
    return new Window { handle=hwnd.ToInt64(), pid=pid, className=cls.ToString(), title=title.ToString(), left=rect.left, top=rect.top, width=rect.right-rect.left, height=rect.bottom-rect.top };
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
    long nextFrame=0; string previous="";
    File.WriteAllText(Path.Combine(control,"monitor-ready"), "ready");
    try {
      while (!File.Exists(Path.Combine(control,"monitor-stop")) && clock.Elapsed.TotalMinutes < 20) {
        Application.DoEvents();
        var phaseFile=Path.Combine(control,"phase");
        if (File.Exists(phaseFile)) { try { phase=File.ReadAllText(phaseFile); } catch(IOException) {} }
        var windows=Visible();
        var identity=phase + String.Join("|",windows.ConvertAll(w=>w.handle+":"+w.title));
        string filename=null;
        if(clock.ElapsedMilliseconds >= nextFrame) {
          filename=String.Format("desktop-{0:D5}.png",frames++);
          using(var bitmap=new Bitmap(bounds.Width,bounds.Height)) {
            using(var graphics=Graphics.FromImage(bitmap)) graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,bounds.Size);
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
