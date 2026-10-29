# Lists the input controls of one window through Windows UI Automation (read-only).
# Usage: uia.ps1 -Hwnd <number>. Prints base64(UTF-8 JSON): [{type,label,rect:[x,y,w,h]}] in physical pixels.
param([long]$Hwnd, [int]$Max = 300)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ApDpi { [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  public static void On() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } } }
'@
[ApDpi]::On()
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$kinds = @{
  'Edit' = 'textbox'; 'Document' = 'textarea'; 'ComboBox' = 'dropdown'; 'CheckBox' = 'checkbox';
  'RadioButton' = 'radio'; 'Button' = 'button'; 'Spinner' = 'textbox'; 'Slider' = 'slider'; 'Hyperlink' = 'link'
}
$conds = foreach ($k in $kinds.Keys) {
  New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::$k)
}
$cond = New-Object System.Windows.Automation.OrCondition(@($conds))
$root = $A::FromHandle([IntPtr]$Hwnd)
$found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$out = New-Object System.Collections.ArrayList
foreach ($el in $found) {
  if ($out.Count -ge $Max) { break }
  try {
    $c = $el.Current
    if ($c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 4 -or $r.Height -lt 4) { continue }
    $type = $kinds[$c.ControlType.ProgrammaticName -replace '^ControlType\.', '']
    $label = $c.Name
    if (-not $label) { $label = $c.HelpText }
    if (-not $label) { $label = $c.AutomationId }
    [void]$out.Add(@{ type = $type; label = [string]$label; rect = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height) })
  } catch { }
}
$json = ConvertTo-Json -InputObject @($out) -Compress -Depth 4
[Console]::Out.Write([Convert]::ToBase64String((New-Object System.Text.UTF8Encoding($false)).GetBytes($json)))
