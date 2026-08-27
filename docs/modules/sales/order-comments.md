# Pedidos - botón Comentarios

## Procedimiento OMNIS

El botón visible **Comentarios** ejecuta `EPED#2.~CAMBIA COMENT`. La lectura de
Procedures confirmó este flujo:

1. define `FCOMENT` como archivo principal;
2. busca `COMSEQFACT = PESEQ + 10000000` mediante `MSQL/261`;
3. si no existe, llama a `MBASE/71` para insertar un registro;
4. llama al procedimiento `421 (Cambia comentarios)`.

Por lo tanto, abrir la ventana original no es una operación de sólo lectura. La
API deliberadamente reproduce únicamente la lectura y nunca crea el registro
faltante ni escribe `COMCAMBIOS`.

## SELECT literal observado

```sql
SELECT FCOMENT.COMSEQ, COMSEQFACT, COML1, COML2, COML3, COML4,
       COMLETRA, COMCAJA, COML5, COMDNUM, COMDES, COMCAJA2,
       COMCAJA3, COMCAJA4, COMCAMBIOS
FROM FCOMENT
WHERE COMSEQFACT = 10072391
ORDER BY FCOMENT.COMSEQ
LIMIT 1;
```

OMNIS también consulta `FTIPMV`, las sucursales del cliente en `FSUCURSALES`,
el catálogo `FAG` y el usuario actual. Los datos restantes de la ventana ya
están en memoria desde `FPENC`, `FCLI` y las partidas.

## Endpoint

```text
GET /api/sales/orders/:orderId/actions/comments
```

La respuesta conserva `items` para el registro `FCOMENT` y expone en `summary`
el encabezado, descuentos, tipo de cambio (`PETIPOC`), peso y volumen calculados,
saldo del cliente, transporte, usuarios, fechas, importes y sucursales de
entrega. Si no hay `FCOMENT`, `items` es un arreglo vacío; no se ejecuta ningún
`INSERT`.

El mapeo visible de la ventana es: `COML1` = Comentarios, `COMDNUM` = Pedido
Cliente, `COML2..COML4` = las tres líneas de Entregar en, `COML5` = Contacto,
`COMDES` = selector de sucursal, `COMCAJA2` = Alta, `COMCAJA3` = Autorizo y
`COMCAJA4` = Cambios. `COMCAMBIOS` alimenta la bitácora grande inferior.
