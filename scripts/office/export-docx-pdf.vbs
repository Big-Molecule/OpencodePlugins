' Stable Word COM: DOCX -> PDF (ExportAsFixedFormat).
' Usage: cscript //nologo export-docx-pdf.vbs <input.docx> <output.pdf>
' Exit 0 on success, 1 on error. Log lines go to stdout.

Option Explicit
On Error Resume Next

Dim docxPath, pdfPath, word, doc, fso, rc
rc = 1

If WScript.Arguments.Count < 2 Then
  WScript.Echo "ERR usage: cscript //nologo export-docx-pdf.vbs <input.docx> <output.pdf>"
  WScript.Quit 1
End If

docxPath = WScript.Arguments(0)
pdfPath = WScript.Arguments(1)

Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(docxPath) Then
  WScript.Echo "ERR input not found: " & docxPath
  WScript.Quit 1
End If

If fso.FileExists(pdfPath) Then
  fso.DeleteFile pdfPath, True
End If

Set word = CreateObject("Word.Application")
If Err.Number <> 0 Then
  WScript.Echo "ERR create Word.Application: " & Err.Number & " " & Err.Description
  WScript.Quit 1
End If

word.Visible = False
word.DisplayAlerts = 0
word.AutomationSecurity = 3

Set doc = word.Documents.Open(docxPath, False, True, False)
If Err.Number <> 0 Then
  WScript.Echo "ERR Documents.Open: " & Err.Number & " " & Err.Description
  word.Quit
  WScript.Quit 1
End If

' 17 = wdExportFormatPDF; OpenAfterExport=False; OptimizeFor=Print(0); Range=All(0)
doc.ExportAsFixedFormat pdfPath, 17, False, 0, 0
If Err.Number <> 0 Then
  WScript.Echo "ERR ExportAsFixedFormat: " & Err.Number & " " & Err.Description
  Err.Clear
  ' Fallback: SaveAs2 PDF
  doc.SaveAs2 pdfPath, 17
  If Err.Number <> 0 Then
    WScript.Echo "ERR SaveAs2 PDF: " & Err.Number & " " & Err.Description
    doc.Close False
    word.Quit
    WScript.Quit 1
  End If
  WScript.Echo "OK method=SaveAs2"
Else
  WScript.Echo "OK method=ExportAsFixedFormat"
End If

Dim pages
pages = doc.ComputeStatistics(2)
doc.Close False
word.Quit

If Not fso.FileExists(pdfPath) Then
  WScript.Echo "ERR pdf not created: " & pdfPath
  WScript.Quit 1
End If

WScript.Echo "OK pages=" & pages & " pdf=" & pdfPath & " size=" & fso.GetFile(pdfPath).Size
WScript.Quit 0
