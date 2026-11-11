# Validación — material para cinco conversaciones

> Fecha: 2026-11-10 · Para: Alfredo
> Estado del producto: M0–M2 en `main`. Lienzo editor + monitor, motor durable,
> agente **demo** (no real), puerta humana. Sin revisores, sin agentes reales,
> sin portal de cliente.

---

## 0. Qué estás validando, exactamente

No estás validando si la herramienta gusta. Gustar es gratis.

**La afirmación que hay que romper o confirmar:**

> Las agencias y freelancers que ya programan con agentes de IA tienen un
> problema de *verificación* y de *confianza del cliente* lo bastante caro como
> para pagar por resolverlo — y lo bastante consciente como para que ya estén
> haciendo algo al respecto, aunque sea a mano.

Las dos mitades importan. Si duele pero nadie hace nada, no hay presupuesto.
Si hacen algo pero no duele, no hay urgencia.

**Criterios de parada, decididos antes de empezar** (escríbelos, es la única
forma de que no te los reinterpretes luego):

| Señal en 5 conversaciones | Qué significa |
|---|---|
| 0–1 describen el problema sin que tú lo nombres | **Para.** El dolor no existe o no es consciente. |
| 3+ ya tienen un apaño manual (hoja, checklist, capturas al cliente) | **Sigue.** Hay presupuesto donde hay apaño. |
| Alguien dice «¿cuándo lo tienes?» o pregunta precio sin que lo saques tú | **Señal fuerte.** Anótalo literal. |
| Todos dicen «qué interesante» y ninguno cuenta una batalla concreta | **Para y replantea.** Eso es cortesía. |

---

## 1. A quién escribir

**Empieza por los 23 usuarios de ContextForge.** Es tu mejor lista y no es
cercana: ya te conocen, ya usan una herramienta tuya, y por definición son
gente que programa con agentes de IA y le importa el contexto que se pierde.
Ya les escribiste una vez, así que el segundo contacto no es frío.

Filtra los que tengan clientes externos. Ese es el perfil.

**Perfil objetivo:**

- Agencia de 1 a 10 personas, o freelancer con cartera.
- Ya entrega código escrito con Claude Code, Cursor o similar — no «está
  pensando en usarlo».
- **Tiene a alguien a quien rendir cuentas**: un cliente que paga y pregunta.

Ese tercer punto es el que separa tu producto de las doce herramientas
gratuitas que lanzan agentes en paralelo. Si no hay nadie mirando por encima
del hombro, el problema de demostrar lo que hizo la IA no existe.

**Dónde más buscar, por orden de calor:**

1. Los 23 de ContextForge (filtrados por «tiene clientes»).
2. Tu propia red de dashboardhosting.com — gente que ya te ha pagado por algo.
3. Quien te haya escrito alguna vez por el blog o por los MCP.
4. Comunidades de agencias pequeñas e indie hackers, solo si lo anterior no da cinco.

**Objetivo: cinco conversaciones de 20–30 minutos.** No cincuenta. Cinco bien
hechas te dan la respuesta; cincuenta mal hechas te dan ruido con volumen.

---

## 2. El mensaje de contacto

Reglas: no pitches, no adjuntas demo, no pides una reunión «para enseñarte
algo». Pides que te cuenten cómo trabajan. La demo, si llega, llega al final
y solo si ellos empujan.

**Para los usuarios de ContextForge:**

> Asunto: una pregunta sobre cómo revisas el código que escribe la IA
>
> Hola [nombre],
>
> Usas ContextForge, así que supongo que trabajas con agentes de código a
> diario. Estoy investigando algo y me vendría muy bien tu punto de vista —
> no te quiero vender nada.
>
> La pregunta corta: cuando un agente te dice que ha terminado una tarea,
> ¿qué haces exactamente antes de darla por buena? Y si tienes clientes,
> ¿cómo les enseñas lo que se hizo?
>
> ¿Tienes 20 minutos esta semana o la que viene? Me vale una llamada o,
> si lo prefieres, contestarme por escrito.
>
> Gracias,
> Alfredo

**Para contactos de tu red que no usan ContextForge:**

> Asunto: 20 minutos sobre agentes de IA y clientes
>
> Hola [nombre],
>
> Estoy investigando un problema concreto y creo que lo vives: entregas
> código hecho con ayuda de IA a clientes que no están en la sala cuando
> se hace.
>
> No te vendo nada y no tengo nada que enseñarte todavía. Quiero entender
> cómo lo haces hoy: cómo compruebas que el agente hizo bien su trabajo, y
> cómo se lo demuestras a quien paga.
>
> ¿20 minutos esta semana?
>
> Alfredo

**Si alguien contesta «¿qué estás construyendo?»** — responde con una frase y
redirige: *«Una forma de que el trabajo de los agentes sea auditable. Pero
prefiero escucharte antes de contarte nada, porque si te lo cuento ya no me
vas a dar tu versión limpia.»*

---

## 3. La conversación

**Orden innegociable: pasado primero, producto al final.** La gente miente
sobre el futuro sin querer. Sobre lo que hizo la semana pasada, no.

### Calentamiento (3 min)

- «Cuéntame el último proyecto que entregaste. ¿Cuánto de ese código lo
  escribió un agente?»
- «¿Qué agentes usas y desde cuándo?»

### El problema de verificación (8 min) — el núcleo

- **«Cuando el agente dice que ha terminado, ¿qué haces antes de darlo por
  bueno?»** Cállate y deja que conteste entero.
- «¿Cuánto de ese código lees de verdad, línea a línea?»
- **«Cuéntame la última vez que algo se te coló.»** Si tiene una historia,
  tienes un cliente. Si dice «no me ha pasado», pregunta cómo lo sabe.
- «¿Cuánto tiempo te llevó enterarte de que se había colado?»
- «¿Revisar código de un agente te cuesta más o menos que revisar el de una
  persona? ¿Por qué?»

### El problema del cliente (8 min)

- «¿Tus clientes saben cuánto del código lo escribe una IA?»
- **«¿Cómo les enseñas lo que se hizo esta semana?»** Pídele que te enseñe
  el último informe o mensaje real que mandó.
- «¿Alguna vez un cliente ha dudado de un trabajo por sospechar que lo hizo
  una IA? ¿Qué pasó?»
- «¿Quién aprueba que algo esté listo para producción? ¿Cómo lo aprueba?»

### Comportamiento y dinero (5 min) — aquí se cae la cortesía

- **«¿Qué herramientas pagas hoy para esto?»** No «pagarías». Pagas.
- «¿Qué has probado y abandonado? ¿Por qué lo abandonaste?»
- «Si esto lo arreglara alguien, ¿de qué presupuesto saldría? ¿El tuyo o el
  del cliente?»
- «¿Quién decide esa compra en tu sitio?»

### La demo (5 min) — solo si queda tiempo y están enganchados

Si han mirado el reloj dos veces, no la saques. Una demo a alguien que no ha
mostrado dolor convierte una entrevista en una presentación, y ya no aprendes
nada.

---

## 4. Guion de demo — cinco minutos, solo lo que existe

**Antes de arrancar:**

```
npm run db:migrate && npm run seed
npx inngest-cli dev      # otra terminal
npm run dev              # http://localhost:3000/canvas/demo
```

Si las tarjetas salen pegadas, borra `.factory/factory.db` y vuelve a sembrar.

**Di esto literalmente, al empezar:** *«Lo que vas a ver corre con un agente
simulado, no con uno real. Eso está por conectar. Te enseño la parte que ya
funciona para que me digas si resuelve algo tuyo.»*

Esa frase no es modestia. Es el producto: si la demo exagera, el argumento
entero se cae.

### Qué enseñar, en este orden

**1. El flujo parado en la puerta humana** (60 s)
Seis bloques en verde, «Human check» en ámbar — *«Parado. Nada sale de aquí
sin tu sí»* — y «Publicar» en gris.
→ *«Nada llega a producción sin que una persona lo apruebe. No es una
sugerencia del sistema: está bloqueado.»*

**2. La insignia Demo** (15 s)
Señálala tú, antes de que pregunten.
→ *«Cuando esto sea un agente real, esa etiqueta desaparece. Nunca vas a
mirar una pantalla sin saber si lo que ves pasó de verdad.»*

**3. Un bloque fallido con su causa real** (60 s)
→ *«Esto es lo que más me costó: cuando algo falla, la tarjeta dice por qué
falló de verdad — que expiró, que el proveedor se cayó — no una frase
genérica. Y si la frase la escribió un modelo, lleva marca de que la escribió
un modelo.»*

**4. La barra de eventos** (45 s)
Pulsa «Point it out» en una línea.
→ *«Cada línea dice de qué bloque viene y te lleva a él. No hay mensajes
huérfanos.»*

**5. El bucle de rechazo** (30 s)
Señala el cable rojo por debajo del carril.
→ *«Si una revisión rechaza, el trabajo vuelve solo al constructor. Los
revisores están por construir; el camino ya está.»*

**6. Editar durante una ejecución** (45 s)
→ *«Puedes cambiar el flujo mientras algo corre y la ejecución en marcha no
cambia de forma. Trabaja sobre una versión congelada.»*

### Qué NO decir

- Nada sobre los cuatro revisores especializados — **no existen**.
- Nada sobre agentes reales, worktrees o PRs — **no existen**.
- Nada sobre portal de cliente — **no existe**.
- Ni una estimación de fechas. Si preguntan: *«Depende de lo que me digas tú
  y otros cuatro.»*

---

## 5. Las preguntas que separan «interesante» de «te pago»

Cuando acabe la demo, no preguntes «¿qué te parece?». Pregunta:

1. **«¿Qué parte de esto resolvería un problema que tuviste este mes?»**
   Si no identifica uno concreto, no hay dolor.
2. **«¿Qué le falta para que lo usaras el lunes?»**
   La respuesta te da el roadmap real, no el que imaginaste.
3. **«Si existiera hoy, ¿a quién de tu equipo se lo enseñarías primero?»**
   Si no hay nadie, no hay compra.
4. **«¿Esto lo pagarías tú o lo facturarías al cliente?»**
   La segunda respuesta vale el doble: significa que ve valor demostrable.
5. **«¿Conoces a alguien más con este problema que debería hablar conmigo?»**
   Si el dolor es real, hay nombres. Si no los hay, sospecha.

### Cómo leer las respuestas

| Dicen | Significa |
|---|---|
| «Qué interesante», «muy chulo», «útil» | Nada. Cortesía. |
| «Nosotros esto lo hacemos con una hoja de cálculo» | **Oro.** Hay apaño, hay dolor, hay presupuesto. |
| Te cuentan una historia de algo que se les coló | **Oro.** Pídeles detalle. |
| «¿Cuándo lo tienes?» | Señal fuerte. Anótalo con fecha y nombre. |
| «¿Cuánto costaría?» sin que tú saques el precio | La más fuerte de todas. |
| «Si tuviera X lo usaría» | Tibio. Pregunta cuándo fue la última vez que necesitó X. |

---

## 6. Qué anotar, y cómo decidir después

Una tabla por conversación. No confíes en la memoria: a la tercera se te
mezclan y empiezas a recordar lo que querías oír.

| | P1 | P2 | P3 | P4 | P5 |
|---|---|---|---|---|---|
| Usa agentes a diario | | | | | |
| Tiene clientes externos | | | | | |
| Contó una historia concreta de algo colado | | | | | |
| **Tiene un apaño manual hoy** | | | | | |
| Paga ya por algo en este espacio | | | | | |
| Preguntó precio o fecha sin que tú lo sacaras | | | | | |
| Dio nombres de otros con el problema | | | | | |
| Frase literal que más te sorprendió | | | | | |

**La fila en negrita es la que decide.** Un apaño manual es presupuesto
esperando una excusa.

### Después de las cinco

- **3 o más con apaño manual** → construye M3 y vuelve a ellos con un agente
  real. Ya tienes cinco personas esperando.
- **1–2** → el dolor existe pero es estrecho. Averigua qué tienen en común
  esos dos antes de escribir una línea más de código.
- **0** → para. Guarda la rama. Lo construido es honesto y funciona, y eso no
  cambia; lo que cambia es a quién le importa. Mejor saberlo ahora que
  después de M3, M4 y M5.

---

## Un apunte incómodo

El riesgo de estas cinco conversaciones no es que te digan que no. Es que te
digan que sí por educación, tú lo interpretes como validación, y construyas
seis meses sobre un cumplido.

Por eso el guion pregunta por el pasado y no por el futuro, por lo que pagan
y no por lo que pagarían, y por nombres de otros en vez de por opiniones.
Y por eso la demo empieza diciendo lo que **no** funciona todavía.

Es el mismo principio que llevas cuarenta commits aplicando al código:
que nada se presente como más de lo que es. Aplicarlo a la validación es
simplemente no mentirte a ti mismo.
