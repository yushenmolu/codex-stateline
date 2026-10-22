Option Explicit
Dim shell, fso, root, scriptPath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(root, "scripts\start-floating-widget.ps1")
shell.CurrentDirectory = root
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34)
' Window style 0 keeps the console host invisible: this is a desktop widget, not a terminal app.
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  Dim logPath
  logPath = fso.BuildPath(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "codex-companion\launcher.log")
  MsgBox "The Codex widget failed to start or exited with an error." & vbCrLf & vbCrLf & _
         "Diagnostic log: " & logPath & vbCrLf & _
         "You can also run npm run desktop in the project folder to see the full output.", vbExclamation, "Codex Widget"
End If
WScript.Quit exitCode