# API del Orquestador del Agente (Paula)

Endpoint HTTP para chatear con el agente de **Amazon Bedrock AgentCore** a traves
de una Lambda intermediaria. La Lambda recibe un mensaje, invoca el harness,
consume el stream internamente y devuelve la respuesta completa del agente en JSON.

---

## 1. Datos del endpoint

| Campo        | Valor                                                                 |
|--------------|-----------------------------------------------------------------------|
| **URL**      | `https://e4vbnziokk.execute-api.us-east-2.amazonaws.com/Prod/chat`    |
| **Metodo**   | `POST`                                                                 |
| **Region**   | `us-east-2`                                                            |
| **Auth**     | Ninguna (endpoint publico)                                            |
| **CORS**     | Habilitado (`*`) para `POST` y `OPTIONS`                               |

### Headers requeridos

```
Content-Type: application/json
```

---

## 2. Request (cuerpo JSON)

| Campo          | Tipo    | Obligatorio | Descripcion                                                                 |
|----------------|---------|-------------|-----------------------------------------------------------------------------|
| `message`      | string  | Si*         | Texto del usuario. *Obligatorio si no se envia `messages`.                   |
| `sessionId`    | string  | No          | ID de la conversacion. Minimo **33 caracteres**. Ver seccion 4.             |
| `systemPrompt` | string  | No          | Instrucciones para el agente. Sobrescribe el prompt por defecto del server. |
| `maxTokens`    | integer | No          | Limite de tokens de salida. Sobrescribe el default del servidor.            |
| `actorId`      | string  | No          | Identificador del usuario final (para memoria del agente).                  |
| `messages`     | array   | No          | Historial completo de mensajes (uso avanzado). Reemplaza a `message`.       |

### Ejemplo minimo (primer turno)

```json
{
  "message": "hola quien eres"
}
```

### Ejemplo con continuacion de conversacion

```json
{
  "message": "y que puedes hacer?",
  "sessionId": "de45fc13d0534f40a4f931059d8f2011b"
}
```

### Ejemplo con overrides

```json
{
  "message": "resume esto en una frase",
  "systemPrompt": "Responde siempre en una sola frase.",
  "maxTokens": 256,
  "actorId": "usuario-123"
}
```

### Formato avanzado con `messages`

```json
{
  "messages": [
    { "role": "user", "content": [{ "text": "hola" }] },
    { "role": "assistant", "content": [{ "text": "hola, en que ayudo?" }] },
    { "role": "user", "content": [{ "text": "cuentame un chiste" }] }
  ]
}
```

---

## 3. Response

### Exito — `200 OK`

```json
{
  "sessionId": "de45fc13d0534f40a4f931059d8f2011b",
  "reply": "Hola, soy el asistente de Paula. En que puedo ayudarte hoy?",
  "stopReason": "end_turn",
  "usage": {
    "inputTokens": 1148,
    "outputTokens": 16,
    "totalTokens": 1164
  }
}
```

| Campo        | Tipo   | Descripcion                                                        |
|--------------|--------|--------------------------------------------------------------------|
| `sessionId`  | string | ID de la conversacion. **Guardalo y reenvialo** en el proximo turno. |
| `reply`      | string | Respuesta del agente (texto completo ya ensamblado).               |
| `stopReason` | string | Razon de parada: `end_turn`, `max_tokens`, `timeout_exceeded`, ... |
| `usage`      | object | Conteo de tokens (`inputTokens`, `outputTokens`, `totalTokens`).   |

### Error — `4xx` / `5xx`

```json
{
  "sessionId": "de45fc13d0534f40a4f931059d8f2011b",
  "error": "BadRequest",
  "message": "Falta 'message' (o 'messages') en el request.",
  "level": "REQUEST"
}
```

| Campo       | Tipo   | Descripcion                                             |
|-------------|--------|---------------------------------------------------------|
| `sessionId` | string | ID de la conversacion (puede ser `null` si fallo antes). |
| `error`     | string | Codigo de error.                                        |
| `message`   | string | Detalle legible del error.                              |
| `level`     | string | Capa donde ocurrio: `REQUEST`, `IAM`, `ARN`, `VALIDATION`, `THROTTLING`, `HARNESS`, `LAMBDA`. |

#### Tabla de errores

| HTTP | `error`                        | `level`      | Causa tipica                                              |
|------|--------------------------------|--------------|----------------------------------------------------------|
| 400  | `BadRequest`                   | `REQUEST`    | Falta `message`, body no es JSON, `maxTokens` invalido.  |
| 400  | `ValidationException`          | `VALIDATION` | Parametro invalido (ej. `sessionId` con menos de 33 car).|
| 403  | `AccessDeniedException`        | `IAM`        | El rol de la Lambda no puede invocar el harness.         |
| 404  | `ResourceNotFoundException`    | `ARN`        | `HARNESS_ARN` o region incorrectos.                      |
| 429  | `ThrottlingException`          | `THROTTLING` | Limite de peticiones / cuota excedida.                   |
| 500  | `ConfigError`                  | `ARN`        | Falta la variable de entorno `HARNESS_ARN`.              |
| 502  | `BotoCoreError` / `HARNESS`    | `HARNESS`    | Error de comunicacion con el harness.                    |

---

## 4. Manejo de la sesion (conversacion con memoria)

El agente correlaciona los turnos mediante `sessionId`.

1. En el **primer** mensaje **NO** envies `sessionId`. La Lambda genera uno valido
   (33 caracteres) y lo devuelve en la respuesta.
2. Guarda ese `sessionId`.
3. En los **siguientes** mensajes reenvia **ese mismo** `sessionId` para continuar
   la conversacion.

> **Importante:** si envias un `sessionId` propio, debe tener **minimo 33 caracteres**.
> Un valor mas corto produce `502` con `message: "Invalid length for parameter
> runtimeSessionId"`. Lo mas simple es dejar que el servidor lo genere.

---

## 5. Ejemplos de consumo

### cURL

```bash
curl -X POST https://e4vbnziokk.execute-api.us-east-2.amazonaws.com/Prod/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"hola quien eres\"}"
```

### JavaScript (fetch)

```javascript
const API_URL = "https://e4vbnziokk.execute-api.us-east-2.amazonaws.com/Prod/chat";
let sessionId = null;

async function chat(message) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });
  const data = await res.json();
  sessionId = data.sessionId; // guardar para el siguiente turno
  return data.reply;
}

console.log(await chat("hola quien eres"));
console.log(await chat("y que puedes hacer?"));
```

### Python (requests)

```python
import requests

API_URL = "https://e4vbnziokk.execute-api.us-east-2.amazonaws.com/Prod/chat"
session_id = None

def chat(message):
    global session_id
    payload = {"message": message}
    if session_id:
        payload["sessionId"] = session_id
    r = requests.post(API_URL, json=payload, timeout=120)
    data = r.json()
    session_id = data.get("sessionId")
    return data.get("reply")

print(chat("hola quien eres"))
print(chat("en que ciudad estamos?"))
```

---

## 6. Prueba en Postman

1. Metodo: **POST**
2. URL: `https://e4vbnziokk.execute-api.us-east-2.amazonaws.com/Prod/chat`
3. Pestana **Body** -> **raw** -> tipo **JSON**
4. Primer turno (sin `sessionId`):

   ```json
   { "message": "hola quien eres" }
   ```

5. Copia el `sessionId` de la respuesta y usalo en el siguiente turno:

   ```json
   { "message": "y que mas sabes?", "sessionId": "PEGA_AQUI_EL_SESSIONID" }
   ```

---

## 7. Notas de operacion

- **Variables de entorno** (configuradas en la Lambda `paula-apis-orch-agente`):
  `HARNESS_ARN`, `AGENT_REGION`, `HARNESS_QUALIFIER`, `MAX_TOKENS`,
  `TIMEOUT_SECONDS`, `DEFAULT_SYSTEM_PROMPT`.
- **Timeout** de la Lambda: 180 s. **Memoria**: 512 MB.
- **Credenciales**: se toman del rol de ejecucion de la Lambda, nunca del codigo.
- **Seguridad**: el endpoint es publico. Para produccion conviene protegerlo con
  API Key, authorizer (Cognito/JWT) o IAM.
