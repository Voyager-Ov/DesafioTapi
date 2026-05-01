export type FlowStepStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface FlowStepDefinition {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly purpose: string;
}

export interface ManualCommand {
  readonly label: string;
  readonly command: string;
  readonly note: string;
}

export const automatedFlowSteps: FlowStepDefinition[] = [
  {
    id: 'tests',
    title: 'Validar lógica y contratos',
    command: 'npm run test',
    cwd: '.',
    purpose: 'Confirma que la lógica del backend y los tests de la arquitectura siguen verdes.',
  },
  {
    id: 'build',
    title: 'Compilar TypeScript',
    command: 'npm run build',
    cwd: '.',
    purpose: 'Detecta errores de tipado o imports rotos antes de synth.',
  },
  {
    id: 'synth',
    title: 'Sintetizar infraestructura',
    command: 'npx cdk synth TapiStack',
    cwd: 'cdk',
    purpose: 'Verifica que la infraestructura compile y que el stack siga coherente.',
  },
  {
    id: 'diff',
    title: 'Comparar cambios de infraestructura',
    command: 'npx cdk diff TapiStack',
    cwd: 'cdk',
    purpose: 'Muestra el impacto real de los cambios antes de desplegar.',
  },
];

export const manualAwsProofCommands: ManualCommand[] = [
  {
    label: 'Sembrar pendientes',
    command: 'aws dynamodb batch-write-item --region us-east-1 --request-items file://docs/phase2/phase2-pending-seed.json',
    note: 'Prepara los registros para disparar producer y consumer.',
  },
  {
    label: 'Disparar producer',
    command: 'aws lambda invoke --region us-east-1 --function-name tapi-producer --cli-binary-format raw-in-base64-out --payload file://docs/phase2/payload-phase2.json response-phase2.json',
    note: 'Publica el mensaje FIFO y arranca el resto del flujo.',
  },
  {
    label: 'Ver logs del producer',
    command: 'aws logs tail /aws/lambda/tapi-producer --region us-east-1 --since 1h',
    note: 'Sirve para confirmar slotId, cantidad de mensajes y errores.',
  },
  {
    label: 'Ver logs del consumer',
    command: 'aws logs tail /aws/lambda/tapi-consumer --region us-east-1 --since 1h',
    note: 'Sirve para ver la llamada al proveedor y las fallas clasificadas.',
  },
  {
    label: 'Ver logs del workflow',
    command: 'aws logs tail /aws/vendedlogs/states/tapi-consumer-state-machine --region us-east-1 --since 1h',
    note: 'Sirve para confirmar retries, catches y persistencia final.',
  },
];