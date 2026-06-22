param(
  [string]$BaseUrl = "http://localhost:3014",
  [string]$RedirectUri = "http://localhost:7777/callback"
)

$ErrorActionPreference = "Stop"

function Invoke-JsonPost {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][object]$Body,
    [Parameter(Mandatory = $true)][Microsoft.PowerShell.Commands.WebRequestSession]$Session
  )

  Invoke-RestMethod -Method Post -Uri $Uri -ContentType "application/json" -Body ($Body | ConvertTo-Json -Compress -Depth 8) -WebSession $Session
}

function Get-RedirectLocation {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$CookieHeader
  )

  $headers = curl.exe -sS -D - -o NUL -H "Cookie: $CookieHeader" $Uri
  $locationLine = $headers | Select-String -Pattern '^Location: ' | Select-Object -First 1
  if (-not $locationLine) {
    throw "Redirect response did not include a Location header."
  }
  return $locationLine.Line.Substring(10).Trim()
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$id = [guid]::NewGuid().ToString()
$email = "bridge-$id@example.com"
$password = "bridge-pass-123"

Invoke-JsonPost -Uri "$BaseUrl/api/auth/register" -Body @{ email = $email; password = $password; name = "Bridge User" } -Session $session | Out-Null

$client = Invoke-JsonPost -Uri "$BaseUrl/oauth/register" -Body @{
  client_name = "Claude web"
  redirect_uris = @($RedirectUri)
  token_endpoint_auth_method = "client_secret_basic"
} -Session $session

$cookieHeader = ($session.Cookies.GetCookies([uri]$BaseUrl) | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "; "
$authorizeUrl = "$BaseUrl/oauth/authorize?client_id=$($client.client_id)&redirect_uri=$([uri]::EscapeDataString($RedirectUri))&response_type=code&scope=mcp&state=abc123&code_challenge=challenge123&code_challenge_method=plain"
$location = Get-RedirectLocation -Uri $authorizeUrl -CookieHeader $cookieHeader
$redirect = [uri]$location
$query = [System.Web.HttpUtility]::ParseQueryString($redirect.Query)
$code = $query["code"]

$token = Invoke-RestMethod -Method Post -Uri "$BaseUrl/oauth/token" -ContentType "application/x-www-form-urlencoded" -Body @{
  grant_type = "authorization_code"
  code = $code
  redirect_uri = $RedirectUri
  code_verifier = "challenge123"
} -Headers @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($client.client_id):$($client.client_secret)")) }

$mcpInit = Invoke-RestMethod -Method Post -Uri "$BaseUrl/mcp" -ContentType "application/json" -Headers @{
  Authorization = "Bearer $($token.access_token)"
} -Body (@{
  jsonrpc = "2.0"
  id = 1
  method = "initialize"
  params = @{}
} | ConvertTo-Json -Compress -Depth 8)

$mcpTools = Invoke-RestMethod -Method Post -Uri "$BaseUrl/mcp" -ContentType "application/json" -Headers @{
  Authorization = "Bearer $($token.access_token)"
} -Body (@{
  jsonrpc = "2.0"
  id = 2
  method = "tools/list"
  params = @{}
} | ConvertTo-Json -Compress -Depth 8)

[pscustomobject]@{
  email = $email
  client_id = $client.client_id
  token_prefix = $token.access_token.Substring(0, 16)
  init_name = $mcpInit.result.serverInfo.name
  init_version = $mcpInit.result.serverInfo.version
  tool_count = @($mcpTools.result.tools).Count
} | ConvertTo-Json -Compress
