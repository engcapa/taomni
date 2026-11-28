$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$connection = New-Object -ComObject ADODB.Connection
try {
    $connection.ConnectionTimeout = 1
    $connection.CommandTimeout = 1
    $connection.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($pattern in @($env:TAOMNI_FILE_SEARCH_LITERAL, $env:TAOMNI_FILE_SEARCH_FUZZY)) {
        $rows = $connection.Execute("SELECT TOP 384 System.ItemPathDisplay FROM SystemIndex WHERE System.FileName LIKE '$pattern'")
        try {
            while (!$rows.EOF) {
                $path = [string]$rows.Fields.Item(0).Value
                if ($path -and $seen.Add($path)) {
                    [Console]::Write($path)
                    [Console]::Write([char]0)
                    if ($seen.Count -ge 384) { return }
                }
                $rows.MoveNext()
            }
        } finally {
            $rows.Close()
        }
    }
} finally {
    if ($connection.State -eq 1) { $connection.Close() }
}
