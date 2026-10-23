Option Explicit
Dim fileSystem, shell, scriptPath, powershellPath, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptPath = fileSystem.BuildPath(fileSystem.GetParentFolderName(WScript.ScriptFullName), "scripts\open-pelican-animation.ps1")
If Not fileSystem.FileExists(scriptPath) Then
    MsgBox "Could not find the animation launcher: " & scriptPath, vbCritical, "Pelican Animation"
    WScript.Quit 1
End If
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Chr(34) & powershellPath & Chr(34) & " -STA -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34)
shell.Run command, 0, False