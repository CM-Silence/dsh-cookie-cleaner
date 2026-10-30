' dsh-cookie-cleaner sentinel (VBScript).
'
' Why VBS: cmd.exe is a console program, so from a GUI parent it either owns a
' visible console (window keeps flashing as it spawns timeout/tasklist every 2s)
' or, with DETACHED_PROCESS, it has no console at all and every child allocates
' its own window. wscript.exe is GUI-subsystem: it never owns a console, and
' WshShell.Run with window style 0 keeps the node child hidden too.
'
' usage: wscript //nologo //B watch.vbs <pid,pid> <node.exe> <helper.mjs>
Option Explicit

Dim pids, nodeExe, helperPath, shell, wmi, i, alive, found, pidText
pids = Split(WScript.Arguments(0), ",")
nodeExe = WScript.Arguments(1)
helperPath = WScript.Arguments(2)

Set shell = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")

Do
  alive = False
  For i = 0 To UBound(pids)
    pidText = Trim(pids(i))
    If Len(pidText) > 0 Then
      Set found = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pidText)
      If found.Count > 0 Then alive = True
    End If
  Next
  If Not alive Then Exit Do
  WScript.Sleep 2000
Loop

' Clean once, hidden, and do not wait: the helper exits by itself.
shell.Run """" & nodeExe & """ --no-warnings """ & helperPath & """ --pids " & WScript.Arguments(0), 0, False
