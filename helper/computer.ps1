# dsh-gui-agent Windows helper.
# JSON-lines worker: one request per stdin line, one response per stdout line.
# Protocol: {"id":<any>,"op":"<name>","args":{...}} -> {"id":<any>,"ok":true,"result":...}
#           or {"id":<any>,"ok":false,"error":"<message>"}
# Requires Windows PowerShell 5.1 (no external modules).

$ErrorActionPreference = 'Stop'

try {
  [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  $script:uiaOk = $true
} catch {
  $script:uiaOk = $false
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Gui32
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; [FieldOffset(8)] public HARDWAREINPUT hi; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lparam);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    public delegate bool EnumProc(IntPtr h, IntPtr lparam);

    public static bool EnableDpi()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
        try { if (SetProcessDpiAwareness(2) == 0) return true; } catch { }
        try { if (SetProcessDPIAware()) return true; } catch { }
        return false;
    }

    public static int MouseButton(string button, bool down)
    {
        uint flag;
        if (button == "right") flag = down ? 0x0008u : 0x0010u;
        else if (button == "middle") flag = down ? 0x0020u : 0x0040u;
        else flag = down ? 0x0002u : 0x0004u;
        INPUT inp = new INPUT();
        inp.type = 0;
        inp.mi.dwFlags = flag;
        return (int)SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int Wheel(int delta)
    {
        INPUT inp = new INPUT();
        inp.type = 0;
        inp.mi.mouseData = unchecked((uint)delta);
        inp.mi.dwFlags = 0x0800u;
        return (int)SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int KeyRaw(int vk, int scan, uint flags)
    {
        INPUT inp = new INPUT();
        inp.type = 1;
        inp.ki.wVk = (ushort)vk;
        inp.ki.wScan = (ushort)scan;
        inp.ki.dwFlags = flags;
        return (int)SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int KeyDown(int vk, bool extended) { return KeyRaw(vk, 0, extended ? 0x0001u : 0u); }
    public static int KeyUp(int vk, bool extended) { return KeyRaw(vk, 0, (extended ? 0x0001u : 0u) | 0x0002u); }
    public static int KeyUnicode(ushort ch, bool up) { return KeyRaw(0, ch, 0x0004u | (up ? 0x0002u : 0u)); }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern short VkKeyScanW(char ch);

    public static bool IsExtended(int vk)
    {
        return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28
            || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 || vk == 0x2C;
    }
}
'@ -ErrorAction Stop

$script:aware = [Gui32]::EnableDpi()

function Get-Arg {
  param($Bag, [string]$Name, $Default = $null)
  if ($null -eq $Bag) { return $Default }
  $prop = $Bag.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $Default }
  return $prop.Value
}

function To-Hwnd {
  param($Value)
  if ($null -eq $Value) { return [IntPtr]::Zero }
  return [IntPtr]([int64]$Value)
}

function Assert-Input {
  param([int]$Sent, [string]$What)
  if ($Sent -ne 1) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw ("${What}: SendInput was rejected (Win32 error $err)")
  }
}

function Get-WindowList {
  # The EnumWindows callback is a delegate-backed scriptblock: it runs in the
  # script scope, so state travels through $script: variables (function locals
  # are not visible from inside the callback).
  $script:windowList = New-Object System.Collections.ArrayList
  $script:windowEnumError = $null
  $script:windowForeground = [Gui32]::GetForegroundWindow()
  $callback = [Gui32+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    try {
      if (-not [Gui32]::IsWindowVisible($hWnd)) { return $true }
      $sb = New-Object System.Text.StringBuilder 512
      [void][Gui32]::GetWindowTextW($hWnd, $sb, 512)
      $title = $sb.ToString()
      if ([string]::IsNullOrWhiteSpace($title)) { return $true }
      $rect = New-Object 'Gui32+RECT'
      [void][Gui32]::GetWindowRect($hWnd, [ref]$rect)
      if (($rect.Right - $rect.Left) -le 0) { return $true }
      $procId = 0
      [void][Gui32]::GetWindowThreadProcessId($hWnd, [ref]$procId)
      [void]$script:windowList.Add([pscustomobject]@{
        handle    = $hWnd.ToInt64()
        title     = $title
        pid       = $procId
        x         = $rect.Left
        y         = $rect.Top
        width     = $rect.Right - $rect.Left
        height    = $rect.Bottom - $rect.Top
        active    = ($hWnd -eq $script:windowForeground)
        minimized = [Gui32]::IsIconic($hWnd)
      })
    } catch { $script:windowEnumError = $_.Exception.Message }
    return $true
  }
  $script:windowEnumCallback = $callback
  [void][Gui32]::EnumWindows($callback, [IntPtr]::Zero)
  $script:windowEnumCallback = $null
  return @($script:windowList)
}

function Get-UiaInfo {
  param($Element, [int]$Depth)
  $current = $Element.Current
  $rect = $current.BoundingRectangle
  return [pscustomobject]@{
    name         = [string]$current.Name
    controlType  = ([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
    className    = [string]$current.ClassName
    automationId = [string]$current.AutomationId
    enabled      = [bool]$current.IsEnabled
    offscreen    = [bool]$current.IsOffscreen
    depth        = $Depth
    x            = [int]$rect.X
    y            = [int]$rect.Y
    width        = [int]$rect.Width
    height       = [int]$rect.Height
    centerX      = [int]($rect.X + ($rect.Width / 2))
    centerY      = [int]($rect.Y + ($rect.Height / 2))
  }
}

function Get-UiaRootWindow {
  param($Args2)
  $handleArg = Get-Arg $Args2 'handle' $null
  if ($null -ne $handleArg -and [int64]$handleArg -ne 0) { return (To-Hwnd $handleArg) }
  $title = [string](Get-Arg $Args2 'title' '')
  $windows = @(Get-WindowList)
  if (-not [string]::IsNullOrWhiteSpace($title)) {
    foreach ($w in $windows) {
      if ($w.title.IndexOf($title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return (To-Hwnd $w.handle) }
    }
    throw "no visible window title contains '$title'"
  }
  $fg = [Gui32]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) { return $fg }
  throw 'no foreground window to inspect'
}

function Find-UiaElements {
  param([IntPtr]$Root, [string]$NameLike, [string]$ControlType, [int]$Max, [int]$MaxDepth, [int]$MaxNodes)
  if (-not $script:uiaOk) { throw 'UI Automation is unavailable on this system' }
  $element = [System.Windows.Automation.AutomationElement]::FromHandle($Root)
  if ($null -eq $element) { throw 'UI Automation could not attach to that window' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $results = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($element, 0))
  $nodes = 0
  $deadline = [DateTime]::UtcNow.AddMilliseconds(8000)
  while ($stack.Count -gt 0) {
    if ([DateTime]::UtcNow -gt $deadline -or $nodes -ge $MaxNodes -or $results.Count -ge $Max) { break }
    $entry = $stack.Pop()
    $node = $entry[0]
    $depth = [int]$entry[1]
    $nodes++
    $info = $null
    try { $info = Get-UiaInfo -Element $node -Depth $depth } catch { continue }
    $nameOk = [string]::IsNullOrEmpty($NameLike) -or ($info.name.Length -gt 0 -and $info.name.IndexOf($NameLike, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    $typeOk = [string]::IsNullOrEmpty($ControlType) -or ($info.controlType -eq $ControlType)
    if ($nameOk -and $typeOk -and $info.name.Length -gt 0 -and -not $info.offscreen) { [void]$results.Add($info) }
    if ($depth -ge $MaxDepth) { continue }
    try {
      $child = $walker.GetFirstChild($node)
      while ($null -ne $child) {
        $stack.Push(@($child, $depth + 1))
        $child = $walker.GetNextSibling($child)
      }
    } catch { }
  }
  return [pscustomobject]@{ root = $Root.ToInt64(); scanned = $nodes; items = @($results) }
}

function Get-UiaElementAtPoint {
  param([int]$X, [int]$Y)
  if (-not $script:uiaOk) { throw 'UI Automation is unavailable on this system' }
  $point = New-Object System.Windows.Point($X, $Y)
  $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
  $chain = @()
  $guard = 0
  $cursor = $element
  while ($null -ne $cursor -and $guard -lt 10) {
    $info = $null
    try { $info = Get-UiaInfo -Element $cursor -Depth $guard } catch { break }
    $chain += $info
    $guard++
    try { $cursor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cursor) } catch { break }
  }
  $pt = New-Object 'Gui32+POINT'
  $pt.X = $X
  $pt.Y = $Y
  $hwnd = [Gui32]::WindowFromPoint($pt)
  $title = ''
  if ($hwnd -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Gui32]::GetWindowTextW($hwnd, $sb, 512)
    $title = $sb.ToString()
  }
  $hit = $null
  foreach ($item in $chain) {
    if ($item.name.Length -gt 0 -and $item.controlType -ne 'Document' -and $item.controlType -ne 'Pane' -and $item.controlType -ne 'Group') { $hit = $item; break }
  }
  if ($null -eq $hit) {
    foreach ($item in $chain) { if ($item.name.Length -gt 0) { $hit = $item; break } }
  }
  return [pscustomobject]@{
    x = $X
    y = $Y
    windowHandle = $hwnd.ToInt64()
    windowTitle = $title
    hit = $hit
    chain = @($chain)
  }
}

function Get-LognormalMs {
  param([double]$Mu = 4.02, [double]$Sigma = 0.34, [int]$Min = 14, [int]$Max = 280)
  $u1 = [Math]::Max(0.0001, (Get-Random -Minimum 1 -Maximum 100000) / 100000.0)
  $u2 = (Get-Random -Minimum 0 -Maximum 360) / 57.29578
  $z = [Math]::Sqrt(-2.0 * [Math]::Log($u1)) * [Math]::Cos($u2)
  $ms = [int][Math]::Round([Math]::Exp($Mu + $Sigma * $z))
  return [Math]::Max($Min, [Math]::Min($Max, $ms))
}

function Move-SmoothCursor {
  param([int]$TargetX, [int]$TargetY, [int]$DurationMs = 0, [bool]$Instant = $false, [bool]$Overshoot = $true)
  $p = New-Object 'Gui32+POINT'
  [void][Gui32]::GetCursorPos([ref]$p)
  $sx = [int]$p.X
  $sy = [int]$p.Y
  $dx = $TargetX - $sx
  $dy = $TargetY - $sy
  $dist = [Math]::Sqrt([double]($dx * $dx + $dy * $dy))
  if ($Instant -or $dist -lt 2) {
    [void][Gui32]::SetCursorPos($TargetX, $TargetY)
    return
  }
  if ($DurationMs -le 0) {
    $base = [Math]::Min(540, [Math]::Max(120, $dist * 0.88))
    $DurationMs = [int]($base * (0.88 + (Get-Random -Minimum 0 -Maximum 340) / 1000.0))
  }
  $steps = [int]([Math]::Min(52, [Math]::Max(10, $dist / 10)))
  $arc = [double]([Math]::Min(64, $dist * 0.085)) * (((Get-Random -Minimum 0 -Maximum 2) * 2) - 1)
  if ($dist -gt 0) { $ux = -$dy / $dist; $uy = $dx / $dist; $vx = $dx / $dist; $vy = $dy / $dist } else { $ux = 0.0; $uy = 0.0; $vx = 0.0; $vy = 0.0 }
  # two-segment asymmetric Bezier: accelerate in, decelerate out, slight overshoot then correct
  $overshoot = 0
  if ($Overshoot -and $dist -gt 26) { $overshoot = Get-Random -Minimum 2 -Maximum 8 }
  $overX = $TargetX + [int]($vx * $overshoot)
  $overY = $TargetY + [int]($vy * $overshoot)
  $c1x = $sx + ($dx * 0.34) + ($ux * $arc * 1.15)
  $c1y = $sy + ($dy * 0.34) + ($uy * $arc * 1.15)
  $c2x = $sx + ($dx * 0.74) - ($ux * $arc * 0.55)
  $c2y = $sy + ($dy * 0.74) - ($uy * $arc * 0.55)
  $perStep = [int]([Math]::Max(3, [Math]::Round($DurationMs / $steps)))
  for ($i = 1; $i -le $steps; $i++) {
    $t = $i / [double]$steps
    $e = if ($t -lt 0.5) { 2.0 * $t * $t } else { 1.0 - [Math]::Pow(-2.0 * $t + 2.0, 2) / 2.0 }
    $u = 1.0 - $e
    $bx = ($u * $u * $u * $sx) + (3 * $u * $u * $e * $c1x) + (3 * $u * $e * $e * $c2x) + ($e * $e * $e * $overX)
    $by = ($u * $u * $u * $sy) + (3 * $u * $u * $e * $c1y) + (3 * $u * $e * $e * $c2y) + ($e * $e * $e * $overY)
    # speed wobble: mid-flight steps are slightly larger, ends tighter
    $wob = [Math]::Sin([Math]::PI * $e) * (Get-Random -Minimum -1 -Maximum 2)
    $nx = [int][Math]::Round($bx + (1.0 - [Math]::Sin([Math]::PI * $e)) * (Get-Random -Minimum -1 -Maximum 2))
    $ny = [int][Math]::Round($by + (1.0 - [Math]::Sin([Math]::PI * $e)) * (Get-Random -Minimum -1 -Maximum 2))
    [void][Gui32]::SetCursorPos($nx, $ny)
    Start-Sleep -Milliseconds ([Math]::Max(2, $perStep + (Get-Random -Minimum -2 -Maximum 3)))
  }
  # correction pass: settle exactly on the target like a real hand
  if ($overshoot -gt 0) {
    $corrSteps = Get-Random -Minimum 2 -Maximum 4
    for ($i = 1; $i -le $corrSteps; $i++) {
      $t = $i / [double]$corrSteps
      $e = $t * $t * (3 - 2 * $t)
      $nx = [int][Math]::Round($overX + (($TargetX - $overX) * $e))
      $ny = [int][Math]::Round($overY + (($TargetY - $overY) * $e))
      [void][Gui32]::SetCursorPos($nx, $ny)
      Start-Sleep -Milliseconds ([Math]::Max(6, (Get-Random -Minimum 14 -Maximum 32)))
    }
  }
  [void][Gui32]::SetCursorPos($TargetX, $TargetY)
}

function Invoke-Op {
  param([string]$Op, $Args2)
  switch ($Op) {

    'ping' {
      return [pscustomobject]@{ pid = $PID; platform = 'windows'; aware = $script:aware }
    }

    'screen.info' {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $screens = @()
      $i = 0
      foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $screens += [pscustomobject]@{
          index  = $i
          name   = $s.DeviceName
          primary = $s.Primary
          x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height
        }
        $i++
      }
      $p = New-Object 'Gui32+POINT'
      [void][Gui32]::GetCursorPos([ref]$p)
      return [pscustomobject]@{
        aware = $script:aware
        virtual = [pscustomobject]@{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
        cursor = [pscustomobject]@{ x = $p.X; y = $p.Y }
        screens = $screens
      }
    }

    'cursor.get' {
      $p = New-Object 'Gui32+POINT'
      [void][Gui32]::GetCursorPos([ref]$p)
      return [pscustomobject]@{ x = $p.X; y = $p.Y }
    }

    'mouse.move' {
      $x = [int](Get-Arg $Args2 'x' 0)
      $y = [int](Get-Arg $Args2 'y' 0)
      $instant = [bool](Get-Arg $Args2 'instant' $false)
      $duration = [int](Get-Arg $Args2 'durationMs' 0)
      Move-SmoothCursor $x $y $duration $instant
      Start-Sleep -Milliseconds 15
      $p = New-Object 'Gui32+POINT'
      [void][Gui32]::GetCursorPos([ref]$p)
      return [pscustomobject]@{ ok = $true; x = $p.X; y = $p.Y }
    }

    'mouse.click' {
      $xArg = Get-Arg $Args2 'x' $null
      $yArg = Get-Arg $Args2 'y' $null
      $instant = [bool](Get-Arg $Args2 'instant' $false)
      # pre-click hesitation: a person decides for a moment before the hand moves
      if (-not $instant) { Start-Sleep -Milliseconds (Get-Random -Minimum 150 -Maximum 500) }
      if ($null -ne $xArg -and $null -ne $yArg) {
        Move-SmoothCursor ([int]$xArg) ([int]$yArg) ([int](Get-Arg $Args2 'durationMs' 0)) $instant
        if ($instant) { Start-Sleep -Milliseconds 30 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 40 -Maximum 160) }
      }
      $button = [string](Get-Arg $Args2 'button' 'left')
      $clicks = [int](Get-Arg $Args2 'clicks' 1)
      $interval = [int](Get-Arg $Args2 'intervalMs' 0)
      if ($clicks -lt 1) { $clicks = 1 }
      for ($i = 0; $i -lt $clicks; $i++) {
        Assert-Input ([Gui32]::MouseButton($button, $true)) 'mouse down'
        if ($instant) { Start-Sleep -Milliseconds 25 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 45 -Maximum 95) }
        Assert-Input ([Gui32]::MouseButton($button, $false)) 'mouse up'
        if ($i -lt ($clicks - 1)) {
          if ($interval -gt 0) { Start-Sleep -Milliseconds $interval }
          elseif ($instant) { Start-Sleep -Milliseconds 90 }
          else { Start-Sleep -Milliseconds (Get-Random -Minimum 70 -Maximum 140) }
        }
      }
      $p = New-Object 'Gui32+POINT'
      [void][Gui32]::GetCursorPos([ref]$p)
      return [pscustomobject]@{ button = $button; clicks = $clicks; x = $p.X; y = $p.Y }
    }

    'mouse.down' { Assert-Input ([Gui32]::MouseButton([string](Get-Arg $Args2 'button' 'left'), $true)) 'mouse down'; return [pscustomobject]@{ ok = $true } }
    'mouse.up'   { Assert-Input ([Gui32]::MouseButton([string](Get-Arg $Args2 'button' 'left'), $false)) 'mouse up'; return [pscustomobject]@{ ok = $true } }

    'mouse.wheel' {
      $delta = [int](Get-Arg $Args2 'delta' 0)
      $notches = [int](Get-Arg $Args2 'notches' 1)
      for ($i = 0; $i -lt [Math]::Max(1, $notches); $i++) {
        Assert-Input ([Gui32]::Wheel($delta)) 'mouse wheel'
        Start-Sleep -Milliseconds 30
      }
      return [pscustomobject]@{ delta = $delta; notches = $notches }
    }

    'mouse.drag' {
      $fx = [int](Get-Arg $Args2 'fromX' 0); $fy = [int](Get-Arg $Args2 'fromY' 0)
      $tx = [int](Get-Arg $Args2 'toX' 0);   $ty = [int](Get-Arg $Args2 'toY' 0)
      $instant = [bool](Get-Arg $Args2 'instant' $false)
      $duration = [int](Get-Arg $Args2 'durationMs' 0)
      if ($duration -le 0) {
        if ($instant) { $duration = 120 } else { $duration = Get-Random -Minimum 240 -Maximum 520 }
      }
      $steps = if ($instant) { 8 } else { [Math]::Max(10, [Math]::Min(40, [int]([Math]::Sqrt([double](($tx - $fx) * ($tx - $fx) + ($ty - $fy) * ($ty - $fy))) / 9))) }
      [void][Gui32]::SetCursorPos($fx, $fy)
      if ($instant) { Start-Sleep -Milliseconds 20 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 40 -Maximum 110) }
      Assert-Input ([Gui32]::MouseButton('left', $true)) 'mouse down'
      if ($instant) { Start-Sleep -Milliseconds 20 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 40 -Maximum 90) }
      $dist = [Math]::Sqrt([double](($tx - $fx) * ($tx - $fx) + ($ty - $fy) * ($ty - $fy)))
      $arc = if ($instant) { 0.0 } else { [double]([Math]::Min(60, $dist * 0.08)) * (((Get-Random -Minimum 0 -Maximum 2) * 2) - 1) }
      if ($dist -gt 0) { $ux = -($ty - $fy) / $dist; $uy = ($tx - $fx) / $dist } else { $ux = 0.0; $uy = 0.0 }
      $perStep = [int]([Math]::Max(4, [Math]::Round($duration / $steps)))
      for ($i = 1; $i -le $steps; $i++) {
        $t = $i / [double]$steps
        $e = $t * $t * (3 - 2 * $t)
        $hump = [Math]::Sin([Math]::PI * $e) * $arc
        $jx = if ($instant) { 0 } else { Get-Random -Minimum -1 -Maximum 2 }
        $jy = if ($instant) { 0 } else { Get-Random -Minimum -1 -Maximum 2 }
        $nx = [int][Math]::Round($fx + (($tx - $fx) * $e) + ($ux * $hump) + $jx)
        $ny = [int][Math]::Round($fy + (($ty - $fy) * $e) + ($uy * $hump) + $jy)
        [void][Gui32]::SetCursorPos($nx, $ny)
        if ($instant) { Start-Sleep -Milliseconds $perStep } else { Start-Sleep -Milliseconds ([Math]::Max(4, $perStep + (Get-Random -Minimum -2 -Maximum 4))) }
      }
      [void][Gui32]::SetCursorPos($tx, $ty)
      Assert-Input ([Gui32]::MouseButton('left', $false)) 'mouse up'
      return [pscustomobject]@{ fromX = $fx; fromY = $fy; toX = $tx; toY = $ty; instant = $instant }
    }

    'key.type' {
      $text = [string](Get-Arg $Args2 'text' '')
      $instant = [bool](Get-Arg $Args2 'instant' $false)
      $delay = [int](Get-Arg $Args2 'delayMs' 8)
      $slow = [double](Get-Arg $Args2 'slowdown' 1)
      if ($slow -le 0) { $slow = 1 }
      # pre-typing hesitation: a hand hovers for a moment before the first key
      if (-not $instant) { Start-Sleep -Milliseconds (Get-Random -Minimum 140 -Maximum 380) }
      $count = 0
      foreach ($ch in $text.ToCharArray()) {
        $count++
        if ($ch -eq "`r") { continue }
        if ($ch -eq "`n") {
          Assert-Input ([Gui32]::KeyDown(0x0D, $false)) 'key down Enter'
          if ($instant) { Start-Sleep -Milliseconds 8 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 18 -Maximum 52) }
          Assert-Input ([Gui32]::KeyUp(0x0D, $false)) 'key up Enter'
          if ($instant) { Start-Sleep -Milliseconds $delay } else { Start-Sleep -Milliseconds (Get-Random -Minimum 30 -Maximum 90) }
          continue
        }
        if ($ch -eq "`t") {
          Assert-Input ([Gui32]::KeyDown(0x09, $false)) 'key down Tab'
          if ($instant) { Start-Sleep -Milliseconds 8 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 18 -Maximum 52) }
          Assert-Input ([Gui32]::KeyUp(0x09, $false)) 'key up Tab'
          if ($instant) { Start-Sleep -Milliseconds $delay } else { Start-Sleep -Milliseconds (Get-Random -Minimum 30 -Maximum 90) }
          continue
        }
        $code = [int][char]$ch
        $vk = -1
        $shift = $false
        if ($code -ge 32 -and $code -lt 127) {
          $scanCode = [int][Gui32]::VkKeyScanW($ch)
          if ($scanCode -ne -1) {
            $mods = [int]((([int]$scanCode) -shr 8) -band 0xFF)
            if (($mods -band 3) -eq $mods) {
              $vk = [int](([int]$scanCode) -band 0xFF)
              $shift = (($mods -band 1) -eq 1)
            }
          }
        }
        if ($vk -ge 0) {
          # real virtual-key path: Chromium reports a proper key value (not "Unidentified")
          if ($shift) {
            Assert-Input ([Gui32]::KeyDown(0x10, $false)) 'shift down'
            Start-Sleep -Milliseconds (Get-Random -Minimum 2 -Maximum 9)
          }
          Assert-Input ([Gui32]::KeyDown($vk, [Gui32]::IsExtended($vk))) "key down $vk"
          if ($instant) { Start-Sleep -Milliseconds 6 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 12 -Maximum 44) }
          Assert-Input ([Gui32]::KeyUp($vk, [Gui32]::IsExtended($vk))) "key up $vk"
          if ($shift) {
            Start-Sleep -Milliseconds (Get-Random -Minimum 2 -Maximum 9)
            Assert-Input ([Gui32]::KeyUp(0x10, $false)) 'shift up'
          }
        } else {
          # non-ASCII (CJK etc.): the only correct route is a Unicode key event
          Assert-Input ([Gui32]::KeyUnicode([uint16]$code, $false)) 'key down'
          if ($instant) { Start-Sleep -Milliseconds 4 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 10 -Maximum 36) }
          Assert-Input ([Gui32]::KeyUnicode([uint16]$code, $true)) 'key up'
        }
        # typo + correction: about 3% of letter/digit keys
        if (-not $instant -and ([char]::IsLetterOrDigit($ch)) -and (Get-Random -Minimum 0 -Maximum 100) -lt 3) {
          $wrongVk = Get-Random -Minimum 0x41 -Maximum 0x5B
          Assert-Input ([Gui32]::KeyDown($wrongVk, $false)) 'typo key down'
          Start-Sleep -Milliseconds (Get-Random -Minimum 16 -Maximum 44)
          Assert-Input ([Gui32]::KeyUp($wrongVk, $false)) 'typo key up'
          Start-Sleep -Milliseconds (Get-Random -Minimum 35 -Maximum 120)
          Assert-Input ([Gui32]::KeyDown(0x08, $false)) 'backspace key down'
          Start-Sleep -Milliseconds (Get-Random -Minimum 16 -Maximum 44)
          Assert-Input ([Gui32]::KeyUp(0x08, $false)) 'backspace key up'
          Start-Sleep -Milliseconds (Get-Random -Minimum 30 -Maximum 90)
        }
        if ($instant) {
          Start-Sleep -Milliseconds $delay
        } else {
          $gap = Get-LognormalMs
          $gap = [int]($gap * $slow)
          if ($ch -eq ' ') { $gap = [int]($gap * 0.7) }
          if ([char]::IsPunctuation($ch) -or [char]::IsWhiteSpace($ch)) { $gap = [int]($gap * 1.18) }
          Start-Sleep -Milliseconds ([Math]::Max(8, $gap))
          if ($count % 11 -eq 0 -and (Get-Random -Minimum 0 -Maximum 3) -eq 0) {
            Start-Sleep -Milliseconds (Get-Random -Minimum 110 -Maximum 260)
          }
        }
      }
      return [pscustomobject]@{ typed = $text.Length; instant = $instant }
    }

    'key.combo' {
      $raw = @(Get-Arg $Args2 'vks' @())
      $vks = @()
      foreach ($v in $raw) { $vks += [int]$v }
      if ($vks.Count -eq 0) { throw 'key.combo requires vks' }
      $instant = [bool](Get-Arg $Args2 'instant' $false)
      $hold = [int](Get-Arg $Args2 'holdMs' 0)
      if ($hold -le 0) {
        if ($instant) { $hold = 40 } else { $hold = Get-Random -Minimum 55 -Maximum 115 }
      }
      foreach ($vk in $vks) {
        Assert-Input ([Gui32]::KeyDown($vk, [Gui32]::IsExtended($vk))) "key down $vk"
        if ($instant) { Start-Sleep -Milliseconds 15 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 12 -Maximum 38) }
      }
      Start-Sleep -Milliseconds $hold
      for ($i = $vks.Count - 1; $i -ge 0; $i--) {
        Assert-Input ([Gui32]::KeyUp($vks[$i], [Gui32]::IsExtended($vks[$i]))) "key up $($vks[$i])"
        if ($instant) { Start-Sleep -Milliseconds 10 } else { Start-Sleep -Milliseconds (Get-Random -Minimum 8 -Maximum 26) }
      }
      return [pscustomobject]@{ vks = $vks }
    }

    'uia.find' {
      $handle = Get-UiaRootWindow $Args2
      $nameLike = [string](Get-Arg $Args2 'name' '')
      $controlType = [string](Get-Arg $Args2 'controlType' '')
      $max = [int](Get-Arg $Args2 'max' 80)
      $maxDepth = [int](Get-Arg $Args2 'maxDepth' 16)
      $maxNodes = [int](Get-Arg $Args2 'maxNodes' 4000)
      if ($max -lt 1) { $max = 1 }
      if ($max -gt 500) { $max = 500 }
      if ($maxDepth -lt 1) { $maxDepth = 1 }
      if ($maxNodes -lt 100) { $maxNodes = 100 }
      $found = Find-UiaElements -Root $handle -NameLike $nameLike -ControlType $controlType -Max $max -MaxDepth $maxDepth -MaxNodes $maxNodes
      $sb = New-Object System.Text.StringBuilder 512
      [void][Gui32]::GetWindowTextW($handle, $sb, 512)
      return [pscustomobject]@{
        windowHandle = $handle.ToInt64()
        windowTitle = $sb.ToString()
        scanned = $found.scanned
        items = $found.items
      }
    }

    'uia.at' {
      $x = [int](Get-Arg $Args2 'x' 0)
      $y = [int](Get-Arg $Args2 'y' 0)
      return (Get-UiaElementAtPoint -X $x -Y $y)
    }

    'window.list' { return Get-WindowList }

    'window.active' {
      $h = [Gui32]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][Gui32]::GetWindowTextW($h, $sb, 512)
      $rect = New-Object 'Gui32+RECT'
      [void][Gui32]::GetWindowRect($h, [ref]$rect)
      return [pscustomobject]@{
        handle = $h.ToInt64(); title = $sb.ToString()
        x = $rect.Left; y = $rect.Top
        width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
      }
    }

    'window.activate' {
      $target = [IntPtr]::Zero
      $handleArg = Get-Arg $Args2 'handle' $null
      if ($null -ne $handleArg -and [int64]$handleArg -ne 0) {
        $target = To-Hwnd $handleArg
      } else {
        $title = [string](Get-Arg $Args2 'title' '')
        if ([string]::IsNullOrWhiteSpace($title)) { throw 'window.activate requires handle or title' }
        foreach ($w in Get-WindowList) {
          if ($w.title.IndexOf($title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $target = To-Hwnd $w.handle
            break
          }
        }
      }
      if ($target -eq [IntPtr]::Zero) { throw 'window not found' }
      if ([Gui32]::IsIconic($target)) { [void][Gui32]::ShowWindow($target, 9) }
      $ok = [Gui32]::SetForegroundWindow($target)
      Start-Sleep -Milliseconds 160
      $fg = [Gui32]::GetForegroundWindow()
      return [pscustomobject]@{ ok = $ok; foreground = ($fg -eq $target); handle = $target.ToInt64() }
    }

    'window.show' {
      $target = To-Hwnd (Get-Arg $Args2 'handle' 0)
      if ($target -eq [IntPtr]::Zero) { throw 'window.show requires handle' }
      $cmd = [int](Get-Arg $Args2 'cmd' 9)
      [void][Gui32]::ShowWindow($target, $cmd)
      return [pscustomobject]@{ handle = $target.ToInt64(); cmd = $cmd }
    }

    'window.close' {
      $target = To-Hwnd (Get-Arg $Args2 'handle' 0)
      if ($target -eq [IntPtr]::Zero) { throw 'window.close requires handle' }
      $ok = [Gui32]::PostMessageW($target, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
      return [pscustomobject]@{ ok = $ok; handle = $target.ToInt64() }
    }

    'screen.capture' {
      $outPath = [string](Get-Arg $Args2 'path' '')
      if ([string]::IsNullOrWhiteSpace($outPath)) { throw 'screen.capture requires path' }
      $monitor = Get-Arg $Args2 'monitor' 'all'
      $scale = [double](Get-Arg $Args2 'scale' 1)
      if ($scale -le 0 -or $scale -gt 1) { $scale = 1 }

      $srcX = 0; $srcY = 0; $srcW = 0; $srcH = 0
      if ($monitor -eq 'all') {
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $srcX = $vs.X; $srcY = $vs.Y; $srcW = $vs.Width; $srcH = $vs.Height
      } else {
        $screens = [System.Windows.Forms.Screen]::AllScreens
        $idx = [int]$monitor
        if ($idx -lt 0 -or $idx -ge $screens.Count) { throw "monitor index out of range: $idx" }
        $s = $screens[$idx]
        $srcX = $s.Bounds.X; $srcY = $s.Bounds.Y; $srcW = $s.Bounds.Width; $srcH = $s.Bounds.Height
      }

      $bmp = New-Object System.Drawing.Bitmap([int]$srcW, [int]$srcH)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.CopyFromScreen($srcX, $srcY, 0, 0, (New-Object System.Drawing.Size([int]$srcW, [int]$srcH)))
      } finally {
        $g.Dispose()
      }

      $outW = [int][Math]::Max(1, [Math]::Round($srcW * $scale))
      $outH = [int][Math]::Max(1, [Math]::Round($srcH * $scale))
      $final = $bmp
      if ($outW -ne $srcW -or $outH -ne $srcH) {
        $resized = New-Object System.Drawing.Bitmap($outW, $outH)
        $rg = [System.Drawing.Graphics]::FromImage($resized)
        try {
          $rg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $rg.DrawImage($bmp, 0, 0, $outW, $outH)
        } finally {
          $rg.Dispose()
        }
        $bmp.Dispose()
        $final = $resized
      }
      try {
        $final.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $final.Dispose()
      }

      $p = New-Object 'Gui32+POINT'
      [void][Gui32]::GetCursorPos([ref]$p)
      $fg = [Gui32]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][Gui32]::GetWindowTextW($fg, $sb, 512)

      return [pscustomobject]@{
        path = $outPath
        width = $outW; height = $outH
        screenX = $srcX; screenY = $srcY
        screenWidth = $srcW; screenHeight = $srcH
        scale = $scale
        cursor = [pscustomobject]@{ x = $p.X; y = $p.Y }
        activeWindow = $sb.ToString()
        aware = $script:aware
      }
    }

    default { throw "unknown op: $Op" }
  }
}

while ($true) {
  $line = $null
  try { $line = [Console]::In.ReadLine() } catch { break }
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $id = $null
  $response = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $result = Invoke-Op -Op ([string]$request.op) -Args2 $request.args
    $response = [pscustomobject]@{ id = $id; ok = $true; result = $result }
  } catch {
    $message = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($message)) { $message = 'operation failed' }
    $response = [pscustomobject]@{ id = $id; ok = $false; error = $message }
  }

  try {
    $json = $response | ConvertTo-Json -Compress -Depth 12
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch { }
}
