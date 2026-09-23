# HA3D Lab — auditoria da baseline `v0.2.59`

Auditado em 23/09/2026 a partir da tag imutável `v0.2.59` (`90bb74a33eb23a7353a38e69e8be6f136cf17aaf`, commit resolvido `ddd5eea57630a4c04026ca53dfc13f80a6a030ca`). Nenhum arquivo do repositório principal foi modificado.

## 1. Arquitetura encontrada

O componente Home Assistant é `custom_components/ha3d`. O backend registra o painel `ha3d-panel`, arquivos estáticos em `/ha3d_static`, e APIs para configuração, upload/carregamento de GLB, assets de cena, luzes virtuais, widgets, aliases e proximidade de marcadores. A configuração persistida em `.storage` contém, entre outros, `bindings`, `object_positions`, `advanced_bindings`, `robots`, `virtual_lights` e `scene_assets`.

No frontend, `ha3d-panel.js` cria o WebGL renderer, cena Three.js, `OrbitControls`, `GLTFLoader`, loop de renderização, carga do GLB e vistas básicas. `ha3d-entry.js` carrega uma cadeia de extensões; a maior parte delas acrescenta ou envolve métodos do mesmo `ha3d-panel`:

- cena/qualidade e luzes: `ha3d-scene.js`, `ha3d-graphics.js`, família `ha3d-virtual-light-*`;
- GLB, entidades e marcadores: `ha3d-entity-markers.js`, `ha3d-exact-light-binding.js`, `ha3d-binding-*`, `ha3d-entity-aliases.js`;
- editor e seleção: `ha3d-editor-object-root.js`, `ha3d-editor-gizmo-persistence-fix.js`, `ha3d-editor-drag-hotfix.js`, `ha3d-smart-picker.js`;
- assets: `ha3d-scene-assets.js`, que faz load de GLB, aplica transform persistido e descarta geometria/material ao remover;
- robôs: `ha3d-robot-trackers.js`, mapas e hotfixes associados;
- câmera/experiência: views locais, drawer de views, cinematográfico, X-Ray, inspeção de objeto, HUD e widgets.

## 2. Funcionalidades existentes a preservar

- upload e carregamento do GLB principal, revisão de cache, Three.js, câmera e controles;
- bindings automáticos/manuais, aliases, marcadores, brightness/RGB e luzes virtuais;
- editor de raiz lógica de objetos, posição/rotação/escala, inputs numéricos, TransformControls e persistência de `object_positions`;
- Smart Picker (incluindo sua escolha de raiz lógica), inspeção de objetos e saída de inspeção;
- Scene Assets: upload, até 50 assets, load, transform, seleção, persistência e limpeza de recursos;
- robô Xiaomi H50: sensor de posição, calibração por pontos, heading, plano configurável, overlay de mapa e suavização existente;
- vistas salvas em `localStorage`, top view, lentes, cinematográfico e X-Ray;
- controles de qualidade/iluminação e proteções de interação mobile/iPad.

Em particular, a calibração e o mapeamento do robô não serão alterados; a camada Lab só poderá consumir sua posição final como fonte autoritativa.

## 3. Proposta de estrutura do protótipo

O Lab parte da tag e mantém os módulos estáveis intactos. Ele acrescentará uma camada de workspace e serviços pequenos, todos importados no final de `ha3d-entry.js`:

```
ha3d-workspace-ui.js       modos, shell e roteamento de painéis
ha3d-editor-history.js     comandos transacionais undo/redo
ha3d-editor-selection.js   seleção múltipla e cycling após Smart Picker
ha3d-editor-snapping.js    snap e guias somente durante transformações
ha3d-asset-catalog.js      catálogo/UX acima do Scene Assets existente
ha3d-robot-motion.js       continuidade visual limitada e debug opcional
```

Os módulos usarão APIs e estado do painel já existentes, com feature flags e sem mudar o formato dos dados estáveis. Preferência por composição/wrappers pontuais, e não por refatoração do núcleo.

## 4. Organização proposta dos menus

| Modo | Conteúdo |
| --- | --- |
| Live | casa, estados, dispositivos, marcadores, luzes e robô; sem ferramentas de edição |
| Edit | seleção, gizmo, campos numéricos, reset, bindings, propriedades, lock, histórico e seleção múltipla |
| Build | estrutura reservada para grid, snap, paredes, pisos, portas e janelas; nesta fase não cria editor arquitetônico |
| Buy / Assets | catálogo por categoria e fluxo selecionar → inserir → posicionar → associar entidade, utilizando o runtime de Scene Assets |
| Views | vistas salvas, câmera, top view, cinematográfico, X-Ray e inspeção |
| System | GLB, qualidade/performance, robôs, calibração, debug e opções avançadas |

Mobile usa o mesmo modo ativo, em uma barra compacta e drawer; nenhum controle desaparece sem caminho alternativo acessível.

## 5. Sequência recomendada

1. Criar `Jackson-Gomes/HA3D-Lab` a partir de `v0.2.59`, identificá-lo como `0.3.0-lab.1` e confirmar que não tem remoto de escrita para o repositório estável.
2. Introduzir o shell de modos sem mover funcionalidades: apenas agrupar e redirecionar os controles existentes; validar desktop/mobile.
3. Acrescentar histórico transacional para transforms e bindings, depois lock e duplicação de Scene Assets.
4. Adicionar multiseleção e cycling como complemento ao Smart Picker, sem raycast contínuo.
5. Criar catálogo Buy/Assets sobre `ha3d-scene-assets.js`; deixar Build como arquitetura/UI pronta, sem geometria estrutural ainda.
6. Experimentar `ha3d-robot-motion.js` em flag desligada por padrão: buffer de 2–3 amostras, interpolação/previsão curta limitada, reconciliação suave e painel de debug.
7. A cada etapa: `npm run check`, testes de calibração, smoke test manual do HA e commit pequeno. Só módulos explicitamente aprovados poderão ser portados manualmente depois.
