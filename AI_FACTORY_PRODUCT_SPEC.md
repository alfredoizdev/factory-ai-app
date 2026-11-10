# AI FACTORY — Especificación funcional y técnica para construir el producto

> **Documento maestro para un agente de programación (Claude Code, Codex, Cursor u otra IA).**
> Versión: 1.0 · Fecha: 2026-11-10 · Estado: especificación inicial para ejecutar un MVP.
> Idioma de producto inicial: español; preparar internacionalización para inglés.

---

## 0. INSTRUCCIÓN PRINCIPAL PARA LA IA DESARROLLADORA

Actúa como un equipo de ingeniería de producto compuesto por arquitecto de software, desarrollador full-stack, diseñador UX/UI, ingeniero de seguridad, ingeniero QA y DevOps. **Construye una aplicación funcional**, no únicamente un mockup. Usa este documento como fuente de requisitos.

**Modo de trabajo obligatorio:**

1. Examina el repositorio y sus instrucciones antes de modificar nada. Si no existe proyecto, inicialízalo.
2. Escribe un plan breve de ejecución con tareas dependientes, criterios de aceptación y prioridades. Consérvalo en `docs/implementation-plan.md` y actualízalo al completar tareas.
3. Empieza por el vertical slice del MVP descrito en la sección 17: crear proyecto → crear workflow → lanzar tarea → observar estado → recibir resultado → aprobación → persistencia; incluye conexión GitHub y pruebas reproducibles en el siguiente incremento del MVP.
4. Implementa con arquitectura modular, tipos estrictos, migraciones, datos de ejemplo y pruebas. Nunca simules ejecuciones reales sin etiquetarlas como **Demo**.
5. Ejecuta los comandos pertinentes (`lint`, `typecheck`, pruebas, build), arregla lo que falle y documenta lo que no puedas verificar.
6. Tras cada hito, entrega: qué se implementó, cómo ejecutarlo, pruebas realizadas, limitaciones y próximos pasos. No afirmes que una función está integrada si todavía utiliza mocks.
7. Evita integrar todos los proveedores al inicio. Define contratos extensibles y implementa primero un **adaptador real** con configuración explícita. Proporciona un modo demo para quien no tenga claves.
8. No realices `push`, `merge`, `deploy`, envío de correos ni acciones externas con efectos importantes sin permisos y confirmación explícitos cuando correspondan.
9. Ante una decisión no especificada, usa la opción simple, segura y extensible; documenta la decisión en `docs/decisions/`.
10. Entrega un producto utilizable por una persona no técnica sin quitar funcionalidades avanzadas a desarrolladores.

### Resultado mínimo esperado al finalizar la primera implementación

Un usuario puede iniciar sesión, crear una AI Factory (espacio de trabajo), crear un proyecto, abrir un editor de nodos, generar o editar un flujo, lanzar tareas a un ejecutor local autorizado o en modo demo, ver cambios de estado y logs, detener un flujo, revisar un resultado, aprobar/rechazar y consultar el historial persistente. Existe una integración GitHub preparada por OAuth/GitHub App, con operaciones reales implementadas para un conjunto mínimo autorizado.

---

## 1. VISIÓN DEL PRODUCTO

**Nombre de trabajo:** AI Factory (marca por validar; no asumir disponibilidad comercial).

**Definición:** plataforma visual de orquestación, ejecución, supervisión y auditoría de equipos de agentes de IA. El usuario crea objetivos; la AI Factory los convierte en trabajos conectados, distribuye tareas entre agentes/modelos, recoge evidencia, detecta errores y solicita aprobaciones humanas cuando sea necesario.

**No es solamente:**
- Un dashboard decorativo de IA.
- Otro chat con un modelo.
- Un clon completo de n8n.
- Un IDE completo que sustituya Claude Code/Cursor.

**Es:** un **centro de control operativo** que combina flujos visuales, multitarea, agentes especializados, pruebas, control humano y una vista comprensible para clientes.

### Propuesta de valor

> «Define el trabajo. Observa cómo colaboran tus agentes. Verifica qué ocurrió. Aprueba el resultado».

### Principios del producto

- **Visual first, hybrid by design:** canvas tipo n8n + panel lateral de tareas + chat de instrucciones.
- **Evidencia antes que afirmaciones:** estados y progreso derivados de ejecuciones, tests, commits, PR y artefactos.
- **Humano al mando:** permisos, pausa, cancelación, reintento y aprobación.
- **Multiagente y multimodelo:** cada nodo elige tarea, modelo y herramientas; otro agente puede consolidar.
- **Una fábrica, dos experiencias:** Developer Mode y Business Mode comparten un mismo motor.
- **Sencillo por defecto:** lo avanzado se descubre progresivamente.
- **Seguro por defecto:** aislamiento, auditoría, secretos protegidos y mínimo privilegio.

---

## 2. USUARIOS Y PROBLEMAS REALES

| Usuario | Problema | Solución |
|---|---|---|
| Programador con Claude Code/Codex/Cursor | No ve qué hacen varios agentes ni dónde fallaron | Canvas con estado, logs y evidencias |
| Equipo de desarrollo | Ramas incompatibles, tests fallidos, tareas sin responsable | Trabajos aislados, dependencias, GitHub/CI y revisores |
| Agencia/freelancer | Cuesta demostrar progreso a un cliente | Portal cliente con hitos, bloqueos y entregables |
| Responsable técnico | No puede confiar en un «listo» de la IA | Validación automática + aprobación humana |
| Emprendedor sin código | No sabe crear automatizaciones complejas | Crear flujos describiendo una meta en lenguaje natural |
| Equipo de negocio | Tareas repetitivas y herramientas dispersas | Flujos reutilizables + conectores con permisos |

**Mercado inicial recomendado:** desarrolladores independientes y agencias pequeñas que ya usan programación con IA. **Expansión:** equipos de negocios y usuarios no técnicos.

---

## 3. DOS MODOS, UNA SOLA AI FACTORY

### 3.1 Developer Mode — prioridad del MVP

- Vincular repositorios GitHub autorizados.
- Crear tareas de software (features, bugs, revisiones, pruebas).
- Ejecutar tareas paralelas en worktrees/entornos aislados.
- Conectar agentes de programación mediante adaptadores.
- Ver ramas, commits, pull requests y estado de CI.
- Revisar seguridad, UX, UI, código y tests con distintos modelos.
- Consolidar hallazgos y solicitar aprobación antes de merge/deploy.

### 3.2 Business Mode — arquitectura lista, implementación gradual

- Crear flujos de ventas, marketing, documentos y soporte.
- Generar workflows desde una instrucción en español.
- Asignar agentes a investigación, redacción, revisión y entrega.
- Plantillas reutilizables.
- Futuras integraciones (email, Drive, CRM, calendarios) por conectores específicos con consentimiento granular.
- Requerir aprobación humana antes de acciones externas como enviar mensajes, publicar contenido o modificar registros.

**Decisión de alcance:** no construir todos los conectores Business en el MVP. Sí implementar desde el inicio el concepto genérico de `tool / integration / connector` y una plantilla Business en modo demo.

---

## 4. UX: ESTRUCTURA DE LA APLICACIÓN

### 4.1 Navegación principal

Sidebar desktop:

1. **Overview**: proyectos, flujos activos, bloqueos, coste y salud del sistema.
2. **Factories / Projects**: espacios de trabajo y proyectos.
3. **Visual Canvas**: editor de workflows (pantalla principal).
4. **Tasks**: trabajos, cola, prioridad, estado, responsable y dependencias.
5. **Agents & Models**: agentes configurados, capacidades y modelos asignados.
6. **Runs / Activity**: historial, logs, métricas y trazas.
7. **Reviews & Approvals**: evaluaciones, diferencias y decisiones.
8. **Integrations**: GitHub y futuros conectores.
9. **Client Portal**: vista de lectura con permisos, entregables y comentarios.
10. **Settings**: equipo, roles, facturación futura, límites y secretos.

### 4.2 Layout del Visual Canvas

- **Cabecera:** proyecto, branch de referencia, botón Ejecutar, Pausar, Detener, Guardar, historial y entorno Demo/Real muy visible.
- **Izquierda:** biblioteca de nodos agrupada (Trigger, Plan, Agent, Tool, GitHub, Test, Review, Approval, Condition, Merge, Output).
- **Centro:** canvas con grid, conexiones dirigidas, zoom, pan, minimap y auto-layout.
- **Derecha:** inspector contextual del nodo seleccionado (configuración, prompt, modelo, entradas, salidas, errores, logs, permisos y coste).
- **Inferior:** consola de ejecuciones, eventos en vivo y pruebas.
- **Asistente:** chat lateral colapsable: «crea un flujo», «divide en tareas», «¿qué falló?», «propón corrección».

### 4.3 Reglas visuales

- Estilo profesional oscuro, azul para ejecución, verde para éxito, amarillo para espera, rojo para fallo, violeta para agente/revisor.
- No depender solo del color: iconos y texto de estado.
- Nodos legibles; densidad adaptable; evitar brillos excesivos que dificulten lectura.
- Diseño desktop-first, responsive: en móvil usar principalmente monitoring/approvals (no forzar editor completo).
- Estados: `draft`, `queued`, `running`, `waiting_approval`, `passed`, `failed`, `cancelled`, `skipped`, `blocked`.
- Si se abre un nodo, visualizar pasos internos («drill-down»). Ejemplo UX → Login → Registro → Perfil → Dashboard.
- Etiquetar claramente **Simulación/Demo** frente a actividad real.

---

## 5. MOTOR VISUAL DE WORKFLOWS

### 5.1 Tipos de nodos prioritarios

| Nodo | Función | MVP |
|---|---|---|
| Manual Trigger | Iniciar un flujo manualmente | Sí |
| Task | Describir objetivo, responsable, prioridad | Sí |
| AI Agent | Ejecutar un agente/modelo con herramientas autorizadas | Sí: un adaptador real + demo |
| GitHub Branch | Preparar rama/worktree de trabajo | Sí |
| GitHub PR | Crear o enlazar pull request | Sí, con aprobación/autorización |
| Test Suite | Ejecutar comandos de pruebas permitidos y parsear resultados | Sí |
| Review | Revisar salida de un trabajo con criterios | Sí, inicial sencillo |
| Human Approval | Aprobar, rechazar o pedir cambios | Sí |
| Condition | Bifurcar según resultado | Sí |
| Output | Resumen/artefactos/resultado | Sí |
| Parallel Split / Join | Ejecutar varios trabajos y consolidar | Fase siguiente del MVP |
| Scheduled Trigger | Lanzar periódicamente | Fase 2 |
| Business Connector | Integración externa configurable | Fase 2 |
| Model Router | Elegir modelo según coste/capacidad | Fase 2 |

### 5.2 Comportamiento

- El canvas debe serializarse como **grafo dirigido versionado** (nodos + aristas + configuración).
- Validar flujo antes de ejecutar: nodo inicial, conexiones, tipos de input/output, ciclos, permisos y dependencias.
- En el MVP, aceptar grafos acíclicos; los reintentos se modelan como política del nodo, no como ciclos ilimitados.
- Cada ejecución usa una **instantánea inmutable** de la versión del flujo, para que editar el canvas no cambie una ejecución en curso.
- Los nodos reciben un contexto estructurado, producen un resultado estructurado y emiten eventos.
- Retries con máximo configurable, backoff, timeout, cancelación e idempotencia.
- Control de concurrencia por usuario/workspace, proyecto y proveedor.
- Un fallo bloqueante detiene nodos dependientes; otros branches independientes pueden continuar según política.
- En una unión `join`, configurar reglas: `all`, `any`, `required_reviewers`.
- El producto debe indicar qué pruebas se ejecutaron de verdad y cuáles no.

### 5.3 Ejemplo de flujo de desarrollo

```text
[Solicitud] -> [Plan] -> [Dividir tareas]
                           |-> [Frontend Agent] -> [Tests UI] --|
                           |-> [Backend Agent]  -> [Tests API] -|-> [Consolidar]
                           |-> [Docs Agent]     -> [Check] -----|       |
                                                                   [Revisores]
                                                            Seguridad / UX / UI / Código
                                                                          |
                                                                    [Approver]
                                                                          |
                                                                   [Aprobación humana]
                                                                          |
                                                                     [Crear PR]
```

**Importante:** un `Approver` de IA no sustituye controles humanos ni garantiza seguridad. Un fallo crítico en revisión/CI debe bloquear el paso siguiente según política.

---

## 6. MULTITAREA, AGENTES Y MODELOS

### 6.1 Tareas paralelas

- Una tarea contiene `id`, `title`, `goal`, `description`, `inputs`, `acceptanceCriteria`, `priority`, `dependencies`, `status`, `assignee`, `model`, `runId`, `outputs`, `evidence`.
- Mostrar carriles por tarea similares a FAC-101, FAC-102, FAC-103, FAC-104.
- Cada carril vincula tarea → rama → tests → PR → aprobación.
- Permitir pausar, cancelar, reasignar y reintentar desde un panel.
- Detectar si varias tareas modifican archivos similares; avisar antes de consolidar.
- Evitar prometer merge automático sin comprobación de conflictos ni permisos.

### 6.2 Catálogo de agentes

Un agente es una **configuración**: rol, instrucciones, modelo/proveedor, herramientas, presupuesto, límites, entradas/salidas y permisos. No asumir que «agente» significa un proceso independiente permanentemente activo.

Roles de ejemplo:

- **Planner**: divide trabajo y crea especificación.
- **Builder Frontend**: implementa UI.
- **Builder Backend**: implementa API/datos.
- **QA**: ejecuta/verifica tests.
- **Security Reviewer**: busca riesgos.
- **UX Reviewer**: analiza flujos y accesibilidad.
- **UI Reviewer**: analiza consistencia visual.
- **Code Reviewer**: calidad, diseño, pruebas.
- **Approver**: consolida reportes y propone decisión.

### 6.3 Multimodelo

Cada agente puede configurar proveedor/modelo. Ejemplos **ilustrativos**, no prometer soporte inicial: modelos Claude, OpenAI y otros disponibles. No fijar nombres/versiones comerciales en la lógica: la lista debe provenir de adaptadores configurados y modelos realmente accesibles.

Interfaz del adaptador:

```ts
interface AgentProvider {
  id: string;
  listModels(): Promise<ModelDescriptor[]>;
  execute(input: AgentExecutionInput, controls: ExecutionControls): AsyncIterable<AgentEvent>;
  cancel?(providerRunId: string): Promise<void>;
}
```

- En MVP: `DemoAgentProvider` reproducible y un proveedor real elegido según SDK/herramienta confirmados al implementar.
- Mostrar coste estimado solo si el proveedor ofrece datos suficientes; diferenciar estimación de coste facturado.
- Nunca exponer API keys en navegador ni logs.

### 6.4 Contexto y memoria («Brain»)

- Contexto **por workspace, proyecto y ejecución**.
- Fuentes: objetivos, decisiones aprobadas, normas de proyecto, documentos enlazados, issues, resultados de tareas, resúmenes estructurados.
- Respetar aislamiento entre clientes/workspaces.
- Usar resúmenes y referencias verificables; no entregar a agentes un historial ilimitado.
- Permitir editar o retirar instrucciones del proyecto, con historial de cambios.
- Las instrucciones manuales llevan autor, fecha, alcance y estado (`propuesta`, `aprobada`, `aplicada`).
- **No ejecutar automáticamente cualquier texto escrito en una nota**: debe convertirse en tarea validada y autorizada.

---

## 7. GITHUB: INTEGRACIÓN FUNDAMENTAL

### Capacidades iniciales

1. Conectar cuenta/org mediante mecanismo oficial autorizado (preferir GitHub App con permisos mínimos para SaaS; OAuth si el caso lo requiere).
2. Seleccionar repositorios permitidos.
3. Leer ramas, commits, PRs, checks y estados CI pertinentes.
4. Crear rama para una tarea autorizada.
5. Relacionar tarea con rama, commit y PR.
6. Crear PR solo cuando haya resultados preparados y usuario autorizado.
7. Recibir webhooks validados por firma, procesarlos de modo idempotente y mostrar eventos.
8. Respetar branch protection y revisiones obligatorias; **nunca saltarlas**.

### Ejecución de agentes programadores

- Usar un runner/worker aislado fuera del proceso web.
- Clonar repositorio autorizado o crear `git worktree` aislado por tarea.
- Definir comandos allowlist para tests; límites de tiempo y recursos.
- No ejecutar comandos de shell arbitrarios generados por LLM sin controles, sandbox y aprobación según riesgo.
- Secrets con permisos mínimos, redactados en logs, no accesibles al modelo salvo necesidad explícita.
- Nunca mezclar directorios de dos clientes.
- Los PRs deben pasar las validaciones configuradas antes de ofrecer merge.

### Caso concreto

`FAC-101` autentificación → `feature/fac-101` → 5 tests → PR #123 → revisión de seguridad → aprobación humana → merge (si se habilita con permiso).

---

## 8. REVISORES ESPECIALIZADOS Y APROBADOR

### Flujo

- Una tarea que llegó a revisión dispara 4 trabajos independientes:
  - Seguridad
  - UX
  - UI
  - Código
- Cada revisor puede usar modelo distinto, prompt específico, versión de código y evidencia.
- Cada revisor devuelve un resultado **estructurado**, no solo texto libre:

```json
{
  "reviewType": "security",
  "status": "failed",
  "severity": "high",
  "summary": "Se detectó un token expuesto en código cliente",
  "findings": [
    {
      "title": "Token expuesto",
      "file": "src/auth/session.ts",
      "line": 42,
      "explanation": "El secreto aparece en código entregado al navegador",
      "recommendation": "Mover el secreto al servidor",
      "evidenceRefs": ["commit:abc123", "run:test-456"]
    }
  ]
}
```

- El nodo `Approver` **consolida** los cuatro informes, muestra bloqueos y genera recomendación. No oculta desacuerdos.
- Contador de resultados: por ejemplo, **3/4 revisiones aprobadas**, pero **aprobación global bloqueada** porque seguridad falló. No mostrar `0/4` si tres revisiones realmente pasaron.
- Si falta una revisión, el estado global es pendiente, no aprobado.
- Política inicial: findings críticos/altos de seguridad bloquean el avance; configurable por organización con registro de cambios.
- Opcional: acción «crear tareas correctivas» que genere issues/subnodos sujetos a confirmación.

---

## 9. TEST SUITE, ERRORES Y EVIDENCIAS

### En cada nodo

- Estado y hora de inicio/fin.
- Agente/modelo y versión de prompt.
- Entrada/salida resumida.
- Logs y errores redactados.
- Artefactos y evidencias enlazados.
- Número de pruebas pasadas, fallidas, omitidas y no ejecutadas.
- Acciones: inspeccionar, reintentar, crear tarea correctiva, cancelar (según permisos).

### Diagnóstico mostrado al usuario

**Ejemplo:**

- Falló: `Login / Auth token`.
- Causa detectada: token expirado (solo si el log/test lo respalda; si no, marcar «hipótesis»).
- Archivo: `src/auth/session.ts`.
- Severidad: media.
- Responsable: Agent Builder.
- Sugerencia: implementar renovación controlada del token y reejecutar pruebas.

**No atribuir causas con certeza sin evidencia.** El diagnóstico de IA y el resultado de un test deben mostrarse como fuentes distintas.

### Calidad mínima del MVP

- Pruebas de unitarias + integración del backend.
- Una prueba E2E del recorrido principal de usuario.
- Tests de validación de grafo y transición de estados.
- Tests de autorización y separación de workspaces.
- Tests de reintentos, cancelación y webhook duplicado.
- Test para demostrar que una aprobación faltante impide acción bloqueante.

---

## 10. PORTAL DEL CLIENTE

- Ruta separada con control de acceso y visibilidad por proyecto.
- Resumen simple: hitos, entregables, completados, en marcha, bloqueados.
- Explicación en lenguaje natural sustentada por estados verificables.
- Comentarios y aprobación de entregables cuando corresponda.
- Sin secretos, prompts privados, archivos internos ni acceso indiscriminado a repositorios/logs.
- «Progreso %» solo si hay metodología explícita: por ejemplo, hitos ponderados y verificados; de lo contrario mostrar hitos sin porcentaje.

---

## 11. REQUISITOS DE SEGURIDAD Y GOBERNANZA

**Imprescindibles desde el MVP:**

- Autenticación fiable y sesiones seguras.
- Roles: `owner`, `admin`, `developer`, `reviewer`, `client_viewer`.
- Aislamiento multi-tenant en cada consulta y recurso.
- Cifrado de secretos en reposo y TLS en tránsito.
- Permisos granulares para repositorios, herramientas y acciones.
- Auditoría inmutable a nivel lógico: quién disparó, editó, aprobó y canceló.
- Protección de webhooks (firmas + prevención de replay según proveedor).
- Rate limits, control de presupuesto y concurrencia.
- Sandbox para ejecución de código, límites CPU/memoria/tiempo y acceso de red restringido.
- Protección contra prompt injection de repositorios, issues y documentos: tratarlos como datos no confiables; instrucciones del proyecto y permisos tienen prioridad.
- Redacción de secretos/PII de logs y trazas.
- El aprobador IA no puede eludir requerimientos de permisos humanos.
- Merge/deploy/enviar/publicar son capacidades opcionales y controladas, no ejecuciones implícitas.

**Antes de producción pública:** threat modeling, backup/restore, rotación de credenciales, control de retención, política de privacidad, revisiones de dependencias y monitoreo operativo.

---

## 12. ARQUITECTURA RECOMENDADA

### Stack sugerido (ajustar tras revisar repo)

| Capa | Tecnología sugerida | Razón |
|---|---|---|
| Frontend | Next.js + React + TypeScript | App web y rutas protegidas |
| Visual Canvas | `@xyflow/react` (React Flow) | Nodos y aristas interactivos |
| UI | Tailwind + componentes accesibles (p.ej. shadcn/ui) | Consistencia y rapidez |
| Backend | TypeScript/Node.js (API de Next o servicio separado) | Tipos compartidos |
| Base de datos | PostgreSQL + Prisma o Drizzle | Persistencia relacional |
| Cola de trabajos | Redis + BullMQ (o equivalente fiable) | Ejecución asíncrona, retries |
| Eventos en vivo | SSE inicialmente; WebSockets si hace falta bidireccionalidad | Estado en directo |
| Runner | Worker aislado / contenedor por tarea | Ejecutar agentes y tests de forma controlada |
| Auth | Proveedor probado o librería mantenida con RBAC | Usuarios y organizaciones |
| Archivos | Almacenamiento de objetos compatible con S3 | Logs/artefactos/capturas |
| Logs | Logger estructurado + trazabilidad | Auditoría y diagnóstico |

**Regla:** el frontend nunca ejecuta agentes directamente. Un API valida → persiste → encola → worker aislado ejecuta → persiste eventos → UI observa.

### Componentes lógicos

```text
Browser / Client Portal
        |
        v
API + Auth + RBAC ----> PostgreSQL
        |
        +----> Workflow Compiler/Validator
        |              |
        |              v
        +----------> Job Queue ---> Orchestrator/Workers
        |                              |      |       |
        |                              |      |       +--> GitHub App / API
        |                              |      +----------> Agent Providers
        |                              +-----------------> Test Runner
        |
        +----> Event Stream / Audit / Artifacts
```

### No diseñar todo como microservicios desde el día uno

Monolito modular para API/UI con worker separado y contratos bien definidos. Preparar escalabilidad por jobs/tenants sin complejidad operativa innecesaria.

---

## 13. ENTIDADES Y MODELO DE DATOS (BORRADOR)

Entidades principales:

- `User`: identidad, perfil, preferencias.
- `Workspace`: organización/equipo, plan, políticas.
- `Membership`: usuario, workspace, rol.
- `Project`: workspace, descripción, modo developer/business, repositorio opcional.
- `IntegrationConnection`: tipo, workspace, permisos, referencias a secretos, estado.
- `AgentDefinition`: nombre, rol, proveedor, modelo, herramientas permitidas, instrucciones.
- `Workflow`: proyecto, nombre, descripción, versión actual.
- `WorkflowVersion`: definición JSON de nodos/edges, autor, fecha, hash.
- `WorkflowRun`: versión congelada, iniciador, estado, timestamps, presupuesto.
- `NodeRun`: workflowRun, nodeId, estado, intentos, duración, resultados.
- `Task`: proyecto, objetivo, prioridad, dependencias, asignación, rama/PR.
- `TaskDependency`: tarea origen → tarea dependiente.
- `Review`: run, revisor, tipo, findings, estado, evidencia.
- `Approval`: recurso, solicitante, aprobador, decisión, razón, fecha.
- `Artifact`: tipo, storageKey, hash, visibilidad, referencia origen.
- `ExecutionEvent`: secuencia, tipo, referencia, payload redactado, timestamp.
- `AuditLog`: actor, acción, recurso, cambios, timestamp.
- `ProjectInstruction`: texto estructurado, autor, estado, alcance, versión.
- `UsageRecord`: proveedor, modelo, tokens/consumo informado, coste estimado.

**Convenciones:** IDs UUID/ULID, timestamps UTC, índices por workspace/proyecto, claves foráneas explícitas. Todo recurso multi-tenant tiene un `workspaceId` comprobado desde autorización, nunca solamente desde un parámetro enviado por el cliente.

---

## 14. API Y EVENTOS (PROPUESTA)

Rutas orientativas (REST o RPC tipado, sin crear duplicados innecesarios):

```text
POST   /api/workspaces
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
GET    /api/projects/:projectId/workflows
POST   /api/projects/:projectId/workflows
PUT    /api/workflows/:workflowId/draft
POST   /api/workflows/:workflowId/publish
POST   /api/workflows/:workflowId/runs
GET    /api/runs/:runId
POST   /api/runs/:runId/cancel
GET    /api/runs/:runId/events (SSE)
GET    /api/runs/:runId/node-runs
POST   /api/node-runs/:nodeRunId/retry
GET    /api/projects/:projectId/tasks
POST   /api/projects/:projectId/tasks
POST   /api/approvals/:approvalId/decision
GET    /api/integrations/github/status
POST   /api/integrations/github/connect (según flujo oficial)
POST   /api/webhooks/github (verificación de firma)
GET    /api/projects/:projectId/client-summary
```

### Tipos de evento

`run.created`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`, `node.queued`, `node.started`, `node.log`, `node.completed`, `node.failed`, `node.waiting_approval`, `task.branch_created`, `task.tests_updated`, `task.pr_opened`, `review.completed`, `approval.requested`, `approval.decided`.

**Transporte:** cada evento tiene `id`, `sequence`, `runId`, `nodeRunId?`, `timestamp`, `type`, `payload`. El cliente puede reconectar y recuperar eventos perdidos (sin depender exclusivamente de un canal en vivo).

---

## 15. PANTALLAS, INTERACCIONES Y CRITERIOS DE ACEPTACIÓN

### A. Inicio y espacios de trabajo

- Alta/login, crear workspace y proyecto.
- Elegir Developer o Business.
- Un proyecto nuevo incluye workflow de ejemplo editable.
- **Aceptar si:** al recargar permanecen proyecto y decisiones.

### B. Canvas

- Añadir, mover, conectar y eliminar nodos.
- Editar configuración de nodo en inspector.
- Validación visible antes de ejecutar.
- Guardar draft y publicar versión.
- **Aceptar si:** los nodos persisten, las conexiones inválidas se bloquean y cada ejecución usa versión fija.

### C. Task Board / Paralelo

- Lista y carriles visuales por tarea.
- Dependencias y estados observables.
- **Aceptar si:** dos tareas independientes pueden ejecutarse concurrentemente bajo un límite configurado; tareas dependientes esperan.

### D. Ejecución y monitoreo

- Iniciar, cancelar, reintentar bajo política, ver eventos/logs.
- Estado en vivo con reconexión.
- **Aceptar si:** cancelar detiene nuevos pasos y solicita terminación del worker, persistiendo estado; recargar no pierde historial.

### E. GitHub

- Conectar con permisos apropiados y elegir repositorio.
- Leer PRs/checks y relacionarlos a tareas.
- Crear rama/PR con autorización.
- **Aceptar si:** eventos reales cambian el estado del proyecto y los webhooks duplicados no crean entradas duplicadas.

### F. Revisores y aprobaciones

- Mostrar revisiones paralelas y hallazgos separados.
- Consolidar sin ocultar errores.
- Decisiones humanas con motivo.
- **Aceptar si:** un hallazgo bloqueante evita continuar y la aprobación queda auditada.

### G. Portal cliente

- Ver entregables y bloqueos sin acceso al repo.
- **Aceptar si:** un cliente de A no puede leer datos privados de B ni logs internos.

### H. UX y accesibilidad

- Teclado, etiquetas, contraste y estados legibles.
- Estados vacíos, carga, error y permisos insuficientes.
- **Aceptar si:** el recorrido central es posible sin leer documentación técnica.

---

## 16. ALCANCE: QUÉ NO CONSTRUIR TODAVÍA

Para evitar que el proyecto se vuelva imposible antes de lanzarlo, posponer:

- Editor n8n completo con cientos de nodos/conectores.
- Marketplace público de agentes.
- Soporte real para todos los modelos/proveedores simultáneamente.
- Infraestructura cloud de ejecución distribuida masiva.
- Merge/deploy autónomos sin supervisión.
- Sistema integral de facturación en el primer prototipo.
- CRM propio, editor de emails propio o IDE propio.
- Aplicación móvil nativa en la primera fase.

---

## 17. ROADMAP DE IMPLEMENTACIÓN — ORDEN DE CONSTRUCCIÓN

### Hito 0 — Base del repositorio

- Crear app, TypeScript estricto, estructura modular, UI base, `.env.example`, Docker Compose para Postgres/Redis si aplica.
- README con instrucciones reproducibles.
- Pruebas, lint, typecheck y build funcionando.
- Definir esquema DB, seeds y permisos iniciales.

**Entregable:** la app arranca y muestra proyecto demo con navegación real.

### Hito 1 — Vertical slice del Canvas

- Workspace/proyecto persistentes.
- Canvas con nodos Trigger → Task → Agent Demo → Review → Human Approval → Output.
- CRUD de drafts y versiones.
- Validador de flujos y UI de inspector.
- Botón Ejecutar con motor básico persistente.

**Entregable:** flujo de extremo a extremo que persiste al recargar.

### Hito 2 — Observabilidad real

- Cola + worker separado.
- Eventos persistentes + SSE.
- Estados, logs y reintentos acotados.
- Cancelación y manejo de fallos.
- Panel de ejecuciones, línea de tiempo y artefactos.

**Entregable:** detectar en la interfaz cuándo y por qué falla un nodo, sin fingir actividad.

### Hito 3 — Primer agente real

- Contrato `AgentProvider`.
- Adaptador Demo y primer proveedor real oficialmente soportado.
- Permisos, límites de tokens y presupuesto.
- Guardar resultados y evidencias.

**Entregable:** una tarea real ejecutada por un agente autorizado y visible en Canvas.

### Hito 4 — GitHub developer slice

- Conexión GitHub, selección repo, ramas/PR/CI, validación webhook.
- Asociación tarea ↔ branch ↔ PR.
- Runner aislado para un tipo de trabajo autorizado, test command allowlist.

**Entregable:** tarea con cambios/pruebas reales reflejada en dashboard.

### Hito 5 — Paralelo y revisores

- Dependencias, split/join y concurrencia controlada.
- Trabajos aislados por task.
- Revisores Seguridad/UX/UI/Código, reporte consolidado y bloqueo por hallazgo.
- Aprobación humana y registro de acciones.

**Entregable:** ejecutar dos tareas paralelas y consolidar 4 revisiones sin que un fallo de seguridad avance inadvertidamente.

### Hito 6 — Portal cliente y Business demo

- Vista cliente con hitos/entregables autorizados.
- Plantilla Business: Solicitud → Investigación → Redacción → Revisión → Aprobación.
- Diferenciar proveedor simulado de real.

**Entregable:** un cliente consulta progreso sin acceso técnico; un usuario no técnico comprende un flujo demo.

### Hito 7 — Beta comercial

- Invitaciones y roles, documentación, onboarding, métricas, límites, seguridad, backups y pruebas de carga básicas.
- Pilotaje con usuarios reales.
- Valorar precios solo después de validar utilidad.

**Entregable:** beta cerrada lista para probar con pequeños equipos.

---

## 18. ESTRUCTURA DE REPOSITORIO SUGERIDA

```text
ai-factory/
├─ apps/
│  └─ web/                   # Next.js, UI, rutas
├─ packages/
│  ├─ domain/                # Tipos, estados, políticas
│  ├─ workflow-engine/       # Validación, DAG, scheduler
│  ├─ agent-providers/       # Contratos, Demo y real provider
│  ├─ github-integration/    # GitHub API, webhooks
│  ├─ ui/                    # Componentes compartidos
│  └─ config/                # Configuración común
├─ workers/
│  └─ execution/             # Cola + runners controlados
├─ prisma/ or db/            # Schema/migraciones
├─ docs/
│  ├─ implementation-plan.md
│  ├─ architecture.md
│  ├─ security.md
│  ├─ api.md
│  └─ decisions/
├─ tests/
├─ .env.example
├─ docker-compose.yml
└─ README.md
```

Usar un monorepo solo si facilita el trabajo; no convertirlo en un proyecto de infraestructura antes de entregar el flujo principal.

---

## 19. PROMPT DE ACEPTACIÓN PARA EL AGENTE QUE PROGRAMARÁ

Al terminar cada hito, demuestra estos casos:

1. **Persistencia:** creo un proyecto/nodo, recargo y sigue igual.
2. **Ejecución:** ejecuto un flujo demo con al menos 5 nodos y veo eventos reales del motor.
3. **Fallo:** fuerzo un error, el nodo se marca fallido, se registra la causa y no se declara éxito.
4. **Aprobación:** el flujo se queda esperando hasta que una persona autorizada apruebe.
5. **Cancelación:** detener una ejecución impide pasos posteriores.
6. **Paralelismo:** dos trabajos independientes se ejecutan sin compartir directorios/estado.
7. **GitHub:** una rama, commit/PR o check real se refleja desde la API/webhook, cuando integración está configurada.
8. **Seguridad:** un usuario de otro workspace no puede leer ni modificar recursos ajenos.
9. **Claridad:** un usuario no técnico entiende estado y razón de un bloqueo.
10. **Pruebas:** incluye resumen verificable de los tests ejecutados y sus resultados.

### Definición de terminado (Definition of Done)

Una feature **no está terminada** hasta que cumple: código implementado, tipos, control de permisos, manejo de errores, pruebas pertinentes, interfaz funcional, persistencia, instrucciones en README y ausencia de mocks ocultos como integraciones reales.

---

## 20. PRIMERA ORDEN CONCRETA PARA LA IA

**Empieza ahora por el Hito 0 y Hito 1, sin esperar a diseñar todo el producto.** Si no hay un repositorio existente, crea una aplicación web TypeScript con diseño oscuro moderno y React Flow; agrega navegación Overview / Projects / Canvas / Tasks / Runs / Integrations / Settings; esquema de datos básico, un proyecto demo y un flujo editable real. Implementa ejecución demo con estados verificables y aprobación humana persistente. Prepara adaptadores para proveedor de IA real y GitHub, pero márcalos como «pendiente de configurar» hasta que funcionen con credenciales autorizadas. Genera README y ejecuta pruebas. Después continúa en el orden del roadmap y entrega evidencia por hito.

**Restricción final:** el producto es una **AI Factory** operativa; el canvas no es una ilustración. Los nodos deben corresponder a tareas, ejecuciones, resultados y decisiones trazables.
