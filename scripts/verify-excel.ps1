# T-1.5 definitive verification: open the generated workbooks in real Excel.
#
# openpyxl proves the XML is well-formed; only Excel proves Excel is happy with it. If Excel had
# to repair the file it strips exactly the things we care about -- data validations, table
# definitions, sheet protection -- so asserting those survive an Excel open is the real check.
#
# Run after: node scripts/verify-xlsx.mjs && node scripts/verify-scale.mjs

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $root '.test-output'

$pass = 0; $fail = 0
function Check($id, $desc, $block) {
    try {
        $note = & $block
        Write-Host ("  PASS  {0}  {1}{2}" -f $id, $desc, $(if ($note) { "  -- $note" } else { "" }))
        $script:pass++
    } catch {
        Write-Host ("  FAIL  {0}  {1}`n          {2}" -f $id, $desc, $_.Exception.Message)
        $script:fail++
    }
}

Write-Host "`nT-1.5  Definitive verification (real Excel via COM)`n"

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false
$excel.EnableEvents = $false

function Open-Book($name) {
    $p = Join-Path $out $name
    if (-not (Test-Path $p)) { throw "missing $name - run the node tests first" }
    # If the file were malformed Excel would repair it on open, which strips exactly the
    # validations and table definitions the assertions below look for.
    return $excel.Workbooks.Open((Resolve-Path $p).Path)
}

try {
    # ------------------------------------------------------------------ structure
    Check 'T-1.5i' 'Excel opens the export and keeps all three sheets' {
        $wb = Open-Book 'all.xlsx'
        try {
            $names = @($wb.Sheets | ForEach-Object { $_.Name })
            $expect = @('important_instructions','bulk_upload_template','DataSheet')
            if (($names -join '|') -ne ($expect -join '|')) { throw "sheets are $($names -join ', ')" }
            $ds = $wb.Sheets('DataSheet')
            if ($ds.Visible -ne 0) { throw "DataSheet visibility is $($ds.Visible), expected 0 (hidden)" }
            "3 sheets, DataSheet still hidden"
        } finally { $wb.Close($false) }
    }

    # ------------------------------------------------------------------ the real test
    Check 'T-1.5j' 'dropdowns are still live dropdowns inside Excel' {
        $wb = Open-Book 'all.xlsx'
        try {
            $ws = $wb.Sheets('bulk_upload_template')
            # xlValidateList = 3. Excel drops validation entirely when it repairs a file,
            # so reaching this at all means the workbook loaded clean.
            $v = $ws.Range('G2').Validation
            if ($v.Type -ne 3) { throw "G2 validation type is $($v.Type), expected 3 (list)" }
            if ($v.Formula1 -notlike '*BCat*') { throw "G2 dropdown source is '$($v.Formula1)', expected BCat" }
            $n = $ws.Range('N2').Validation
            if ($n.Type -ne 3) { throw "N2 (Best Seller) validation type is $($n.Type)" }
            "G2 -> $($v.Formula1), N2 -> $($n.Formula1)"
        } finally { $wb.Close($false) }
    }

    Check 'T-1.5k' 'sheet protection and the named table survive' {
        $wb = Open-Book 'all.xlsx'
        try {
            $ws = $wb.Sheets('bulk_upload_template')
            if (-not $ws.ProtectContents) { throw 'sheet protection was lost' }
            $lo = $ws.ListObjects
            if ($lo.Count -lt 1) { throw 'the bulk upload table definition was lost' }
            $t = $lo.Item(1)
            if ($t.Name -ne 'tbl_Bulk_Upload_Sheet') { throw "table is named $($t.Name)" }
            "protected, table $($t.Name) present"
        } finally { $wb.Close($false) }
    }

    # ------------------------------------------------------------------ data
    # Note: the table spans A1:Y25000 (as it does in Amazon's original template), so End(xlUp)
    # lands on 25000 regardless of content. CountA is the honest measure of populated rows.
    Check 'T-1.5l' 'Excel reads the expected rows and values' {
        $wb = Open-Book 'all.xlsx'
        try {
            $ws = $wb.Sheets('bulk_upload_template')
            $filled = $excel.WorksheetFunction.CountA($ws.Range('D:D'))
            if ($filled -ne 651) { throw "column D has $filled populated cells, expected 651 (header + 650)" }
            if ($ws.Range('D651').Value2 -eq $null) { throw 'D651 should hold the last product' }
            if ($ws.Range('D652').Value2 -ne $null) { throw "D652 should be empty but holds '$($ws.Range('D652').Value2)'" }

            $name = $ws.Range('D2').Value2
            if ($name -ne '5 STAR 20 GM') { throw "D2 is '$name'" }
            $mrp = $ws.Range('E2').Value2
            if ($mrp -isnot [double] -or $mrp -ne 10) { throw "E2 is '$mrp' ($($mrp.GetType().Name)), expected numeric 10" }
            $img = $ws.Range('P2').Value2
            if ($img -notlike 'https://m.media-amazon.com/*' -or $img -like '*_SX*') { throw "P2 is '$img'" }
            "650 products, clean boundary at D652, E2=$mrp numeric, image URL untouched"
        } finally { $wb.Close($false) }
    }

    Check 'T-1.5m' 'a subset export and a 2600-row export both open clean' {
        $results = @()
        foreach ($f in @(@('subset.xlsx', 131), @('scale-export.xlsx', 2601), @('single.xlsx', 2))) {
            $wb = Open-Book $f[0]
            try {
                $ws = $wb.Sheets('bulk_upload_template')
                $filled = $excel.WorksheetFunction.CountA($ws.Range('D:D'))
                if ($filled -ne $f[1]) { throw "$($f[0]): column D has $filled populated cells, expected $($f[1])" }
                if ($ws.Range('G2').Validation.Type -ne 3) { throw "$($f[0]): dropdown lost" }
                $results += "$($f[0]) $($f[1] - 1) products"
            } finally { $wb.Close($false) }
        }
        $results -join ', '
    }
}
finally {
    $excel.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

Write-Host "`n  $pass passed, $fail failed`n"
if ($fail -gt 0) { exit 1 }
