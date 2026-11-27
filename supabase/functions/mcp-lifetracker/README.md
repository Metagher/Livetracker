# Lifetracker MCP-Server

Supabase Edge Function, die alle 17 Datenbereiche der App (dieselbe Tabelle
`lifetracker_kv_store` wie `index.html`) als MCP-Tools bereitstellt – lesend
und schreibend. Gedacht zum Einbinden als **Custom Connector** in claude.ai.

## Funktionsweise

- **Transport:** MCP "Streamable HTTP", zustandslos (ein JSON-RPC-Request =
  eine Antwort, kein SDK-HTTP-Transport, da dieser auf Node statt die
  Fetch-API von Deno Edge Functions ausgelegt ist).
- **Zugriffsschutz:** Kein OAuth (Supabase Edge Functions laufen zwingend
  unter `/functions/v1/<name>/...` – das macht die von Claude erwartete
  automatische OAuth-Discovery nach RFC 8414 auf diesem Pfad-Präfix
  unzuverlässig). Stattdessen ein klassischer Bearer-Token:
  jeder Request muss `Authorization: Bearer <MCP_SECRET_TOKEN>` mitschicken.
  Fehlt/stimmt der Token nicht, antwortet die Funktion mit `401`.
  Alternativ (falls die Connector-UI keinen eigenen Header erlaubt) wird
  der Token auch als `?token=<MCP_SECRET_TOKEN>`-Query-Parameter oder als
  letztes URL-Pfad-Segment akzeptiert – die URL bleibt sonst stabil:
  `https://<projekt>.supabase.co/functions/v1/mcp-lifetracker`.
- **Datenzugriff:** Die Funktion loggt sich serverseitig mit einem
  Supabase-Auth-Login (Email/Passwort, wie die App selbst) ein und spricht
  danach mit dem resultierenden User-Access-Token gegen
  `/rest/v1/lifetracker_kv_store` – Row Level Security greift exakt wie in
  der Web-App.

## Benötigte Function-Secrets

In Supabase: Project Settings → Edge Functions → Secrets (oder per
`create_edge_function_secret`-MCP-Tool, Wert wird direkt im Dashboard
eingegeben, nie über die KI weitergeleitet):

| Secret | Inhalt |
| --- | --- |
| `MCP_EMAIL` | Login-Email des App-Accounts |
| `MCP_PASSWORD` | Login-Passwort des App-Accounts |
| `MCP_SECRET_TOKEN` | Langer Zufalls-String für die URL (siehe oben) |

`SUPABASE_URL` und `SUPABASE_ANON_KEY` sind von Supabase automatisch in
jeder Edge Function gesetzt – nicht manuell anlegen.

## Einrichtung in claude.ai

1. claude.ai → Settings → Connectors → "Add custom connector"
2. Name: z.B. "Lifetracker"
3. URL: die vollständige Funktions-URL inkl. Token (siehe oben)
4. Authentication: **"No sign in"**
5. Speichern – die Tools erscheinen danach in neuen Chats.

## Deploy

```
supabase functions deploy mcp-lifetracker --no-verify-jwt
```

(oder über das `deploy_edge_function`-MCP-Tool mit `verify_jwt: false` –
die Funktion prüft die Berechtigung selbst über den Pfad-Token, nicht über
ein Supabase-JWT.)

## Sicherheitshinweis

Diese Funktion ist für einen einzelnen, vertrauenswürdigen Nutzer gedacht.
Der Schutz beruht auf der Geheimhaltung der vollständigen URL (inkl.
Token), nicht auf einer kryptografisch geprüften Nutzeranmeldung pro
Request. Bei Verdacht auf Kompromittierung: `MCP_SECRET_TOKEN` in den
Supabase-Secrets ändern und die Funktion neu deployen – die alte URL
funktioniert danach nicht mehr.
