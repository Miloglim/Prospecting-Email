# 开发信标准排版规范

> 所有邮件必须遵循此排版。纯文本格式（非 HTML），适配所有邮件客户端。

---

## 排版规则

| 规则 | 说明 |
|------|------|
| 段落间隔 | 段落之间空一行 |
| 行宽 | 每行不超过 72 个字符（英文）/ 35 个汉字 |
| 强调 | 用 `**文字**` 包裹在 Markdown 转纯文本后保留，或用 `*` 包裹 |
| 签名档 | 用 `-- ` 分隔线（注意后面有空格）与正文隔开 |
| 链接 | 不写裸 URL，写成 `文字 (URL)` 或直接省略 |
| 无 HTML | 不写 `<b>` `<br>` `<a>` 标签——很多客户端不渲染 |

---

## 标准示例（渲染效果）

以下是一封发给墨西哥进口商的开发信在邮件客户端中的最终效果：

```
Asunto: 293 embarques desde Alemania — ¿ya tienes plan B?

Hola,

Entiendo que importan aluminio y acero desde Alemania para
la industria automotriz en Aguascalientes. He trabajado con
proveedores automotrices y sé lo que pesa una entrega fuera
de tiempo — una línea parada no es una opción.

Por eso quería presentarme. Soy Zayne, de YQN. Manejamos
rutas Europa-Altamira con despacho RFC fiscalizado — menos
del 5% de revisión, 3-5 días de liberación — y tenemos
oficina propia aquí, no un agente tercerizado.

Si algún día tu forwarder actual se queda sin espacio o
falla una conexión, tener un segundo canal ya probado te
ahorra dolores de cabeza.

¿Te sirve que te comparta un comparativo de flete
Europa-Altamira? Así tienes una referencia a mano, por si
algún día la necesitas.

Saludos,
--
金颖哲 Zayne Jin | Overseas Sales · LatAm Desk
YQN Logistics Technology Group
zayne_jin@yqn.com | +86 18487665870 | www.yqn.com
```

---

## JSON 模板中的 body 字段写法

上面那封邮件在 `template.json` 中应写成：

```json
{
  "to": "cliente@empresa.mx",
  "company": "BFC Profile de Mexico",
  "subject": "293 embarques desde Alemania — ¿ya tienes plan B?",
  "body": "Hola,\n\nEntiendo que importan aluminio y acero desde Alemania para\nla industria automotriz en Aguascalientes. He trabajado con\nproveedores automotrices y sé lo que pesa una entrega fuera\nde tiempo — una línea parada no es una opción.\n\nPor eso quería presentarme. Soy Zayne, de YQN. Manejamos\nrutas Europa-Altamira con despacho RFC fiscalizado — menos\ndel 5% de revisión, 3-5 días de liberación — y tenemos\noficina propia aquí, no un agente tercerizado.\n\nSi algún día tu forwarder actual se queda sin espacio o\nfalla una conexión, tener un segundo canal ya probado te\nahorra dolores de cabeza.\n\n¿Te sirve que te comparta un comparativo de flete\nEuropa-Altamira? Así tienes una referencia a mano, por si\nalgún día la necesitas.\n\nSaludos,\n--\n金颖哲 Zayne Jin | Overseas Sales · LatAm Desk\nYQN Logistics Technology Group\nzayne_jin@yqn.com | +86 18487665870 | www.yqn.com"
}
```

---

## 常见排版错误

| 错误 | 正确 |
|------|------|
| 全文挤成一段 | 段落之间用 `\n\n`（两个换行） |
| 签名档前无分隔 | 用 `-- ` 或 `---` 分隔 |
| 每行过长（>80字符） | 72 字符处断行 |
| 用 `<br>` 代替 `\n` | 纯文本用 `\n`，不用 HTML |
| 签名档带 emoji（部分客户端乱码） | 去掉 emoji，保留纯文本 |
| ⚠️ 不要用 `**` 加粗 | 纯文本邮件 `**` 会原样显示，不加粗。用自然强调（"重要的是…""关键是…"） |

---

## 两种样式对比

### ❌ 混乱版

```
Hola,Entiendo que importan aluminio y acero desde Alemania para la industria automotriz en Aguascalientes. He trabajado con proveedores automotrices y sé lo que pesa una entrega fuera de tiempo — una línea parada no es una opción.Por eso quería presentarme. Soy Zayne, de YQN. Manejamos rutas Europa-Altamira con despacho RFC fiscalizado — <5% de revisión, 3-5 días de liberación — y tenemos oficina propia aquí, no un agente tercerizado.Si algún día tu forwarder actual se queda sin espacio o falla una conexión, tener un segundo canal ya probado te ahorra dolores de cabeza.¿Te sirve que te comparta un comparativo de flete Europa-Altamira? Así tienes una referencia a mano, por si algún día la necesitas.Saludos,金颖哲 Zayne Jin | YQNzayne_jin@yqn.com | +86 18487665870
```

### ✅ 标准版

```
Hola,

Entiendo que importan aluminio y acero desde Alemania para
la industria automotriz en Aguascalientes. He trabajado con
proveedores automotrices y sé lo que pesa una entrega fuera
de tiempo — una línea parada no es una opción.

Por eso quería presentarme. Soy Zayne, de YQN. Manejamos
rutas Europa-Altamira con despacho RFC fiscalizado — menos
del 5% de revisión, 3-5 días de liberación — y tenemos
oficina propia aquí, no un agente tercerizado.

Si algún día tu forwarder actual se queda sin espacio o
falla una conexión, tener un segundo canal ya probado te
ahorra dolores de cabeza.

¿Te sirve que te comparta un comparativo de flete
Europa-Altamira? Así tienes una referencia a mano, por si
algún día la necesitas.

Saludos,
--
金颖哲 Zayne Jin | Overseas Sales · LatAm Desk
YQN Logistics Technology Group
zayne_jin@yqn.com | +86 18487665870 | www.yqn.com
```

---

## 关键约束（写入 JSON body 时必须遵守）

1. `\n\n` = 段落分隔（空一行）
2. 签名用 `--` 或 `---` 开头的一行
3. 不用 `**粗体**`（纯文本不渲染）
4. 不用 HTML 标签
5. 每行 ≤ 72 字符
