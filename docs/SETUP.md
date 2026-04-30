# Tapi Challenge — Guía de Setup Completo

## Paso 0: Prereqs — qué necesitás tener instalado

### Node.js v20+
```bash
node --version   # tiene que decir v20.x.x o mayor
npm --version    # v10+
```
Si no lo tenés: https://nodejs.org → descargá "LTS"

### AWS CLI
```bash
aws --version    # aws-cli/2.x.x
```
Si no lo tenés:
- **Mac**: `brew install awscli`
- **Windows**: descargá el installer de https://aws.amazon.com/cli/
- **Linux**: `sudo apt install awscli` o seguí https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2-linux.html

---

## Paso 1: Crear tu cuenta AWS (si no tenés)

1. Andá a https://aws.amazon.com → "Create an AWS Account"
2. Necesitás tarjeta de crédito (los servicios de este proyecto entran en el Free Tier)
3. Elegí el plan "Basic (free)"

---

## Paso 2: Crear credenciales AWS (Access Keys)

1. Entrá a https://console.aws.amazon.com
2. Click en tu nombre (arriba a la derecha) → **Security credentials**
3. Bajá hasta **Access keys** → **Create access key**
4. Elegí "CLI" → Next → Create
5. **IMPORTANTE**: copiá el `Access Key ID` y el `Secret Access Key` ahora, después no los podés ver

---

## Paso 3: Configurar AWS CLI con tus credenciales

```bash
aws configure
```

Te va a preguntar 4 cosas:
```
AWS Access Key ID [None]:     ← pegá tu Access Key ID
AWS Secret Access Key [None]: ← pegá tu Secret Access Key
Default region name [None]:   us-east-1
Default output format [None]: json
```

Verificá que funcionó:
```bash
aws sts get-caller-identity
# Tiene que devolver algo como:
# { "UserId": "...", "Account": "123456789012", "Arn": "arn:aws:iam::..." }
```

---

## Paso 4: Instalar AWS CDK globalmente

```bash
npm install -g aws-cdk
cdk --version   # tiene que mostrar algo como 2.148.0
```

---

## Paso 5: Clonar / crear el proyecto

Si ya tenés la carpeta `tapi-challenge` con todos los archivos del Paso 1:

```bash
cd tapi-challenge
```

Si no, creá la carpeta y copiá todos los archivos que te di en la Fase 1.

---

## Paso 6: Instalar dependencias

Hay dos `package.json`: uno en la raíz (para las Lambdas) y uno en `/cdk` (para la infra).
Tenés que instalar ambos.

```bash
# Desde la raíz del proyecto:
npm install

# Dependencias del CDK:
cd cdk
npm install
cd ..
```

---

## Paso 7: CDK Bootstrap (solo se hace UNA VEZ por cuenta/región)

El bootstrap crea recursos internos que CDK necesita para deployar (un bucket S3 para assets).

```bash
cd cdk
cdk bootstrap aws://CUENTA/us-east-1
```

Reemplazá `CUENTA` con tu número de cuenta AWS (el que viste en el Paso 3 con `get-caller-identity`).

Ejemplo real:
```bash
cdk bootstrap aws://123456789012/us-east-1
```

Debería decir: `✅ Environment aws://123456789012/us-east-1 bootstrapped.`

---

## Paso 8: Verificar que el CDK puede synth (compilar sin deployar)

```bash
cd cdk   # si no estás ahí
cdk synth
```

Tiene que generar un CloudFormation template sin errores. Deberías ver algo como:
```
Successfully synthesized to /ruta/cdk/cdk.out
Stack ARNs: arn:aws:cloudformation:us-east-1:...
```

---

## Paso 9: Deployar

```bash
cdk deploy
```

Te va a mostrar los cambios que va a hacer y preguntar `Do you wish to deploy these changes? (y/n)` → escribí `y`.

El deploy tarda unos 2-3 minutos. Al final deberías ver:
```
✅  TapiStack

Outputs:
TapiStack.ProducerFunctionArn = arn:aws:lambda:...
TapiStack.ProviderQueueUrl    = https://sqs.us-east-1...
TapiStack.ResultsTableArn     = arn:aws:dynamodb:...
```

---

## Flujo completo de comandos (resumen)

```bash
# Una sola vez:
npm install -g aws-cdk
aws configure

# Por proyecto (una sola vez):
cd tapi-challenge
npm install
cd cdk && npm install
cdk bootstrap aws://TU_NUMERO_DE_CUENTA/us-east-1

# Cada vez que modificás infra:
cdk synth   # verificar
cdk deploy  # aplicar

# Correr tests:
cd ..       # volver a la raíz
npm test

# Ver diferencias antes de deployar:
cdk diff
```

---

## Comandos útiles de debugging

```bash
# Ver todos los stacks
cdk list

# Ver logs de la Lambda Producer en tiempo real
aws logs tail /aws/lambda/tapi-producer --follow

# Destruir TODA la infra (cuidado en prod)
cdk destroy

# Ver qué hay en la tabla DynamoDB
aws dynamodb scan --table-name tapi-pending-records

# Enviar un mensaje de prueba a SQS FIFO (para testear manualmente)
aws sqs send-message \
  --queue-url "$(aws sqs get-queue-url --queue-name tapi-provider-queue.fifo --query QueueUrl --output text)" \
  --message-body '{"recordId":"test-1","providerId":"prov-A"}' \
  --message-group-id "PROVIDER#prov-A" \
  --message-deduplication-id "test-1-manual"
```
