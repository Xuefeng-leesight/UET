# 自动生成的代码调用图

运行 `npm run docs:codegraph` 更新。扫描当前工作区，包括未提交的源码；这不是运行时跟踪，也不是完整 import 依赖图。

| 语言 | 扫描文件 | 函数节点 | 原始调用边 | 两端有节点的边 | 外部或缺失端点边 |
|---|---:|---:|---:|---:|---:|
| typescript | 268 | 938 | 2331 | 2331 | 0 |
| python | 144 | 910 | 2498 | 2498 | 0 |

## typescript 模块调用图

箭头表示调用方 → 被调用方，数字是扫描得到的跨模块调用边数；模块内部调用省略。无跨模块边的模块仍保留。

```mermaid
flowchart LR
  n0["electron (16 functions)"]
  n1["electron/app (4 functions)"]
  n2["electron/domains (208 functions)"]
  n3["electron/platform (60 functions)"]
  n4["shared/domain (99 functions)"]
  n5["src (1 functions)"]
  n6["src/app (68 functions)"]
  n7["src/features/analysis (116 functions)"]
  n8["src/features/export (8 functions)"]
  n9["src/features/facial (3 functions)"]
  n10["src/features/licensing (8 functions)"]
  n11["src/features/mapping (12 functions)"]
  n12["src/features/multiplayer (13 functions)"]
  n13["src/features/projects (19 functions)"]
  n14["src/features/recording (165 functions)"]
  n15["src/features/records (47 functions)"]
  n16["src/features/stimuli (48 functions)"]
  n17["src/features/subjects (13 functions)"]
  n18["src/infrastructure (19 functions)"]
  n19["src/modalities (5 functions)"]
  n20["src/shared (6 functions)"]
  n0 -->|"2"| n3
  n1 -->|"15"| n3
  n2 -->|"22"| n3
  n2 -->|"11"| n4
  n5 -->|"2"| n6
  n6 -->|"12"| n4
  n6 -->|"3"| n7
  n6 -->|"4"| n10
  n6 -->|"1"| n12
  n6 -->|"9"| n13
  n6 -->|"106"| n14
  n6 -->|"5"| n15
  n6 -->|"6"| n16
  n6 -->|"6"| n17
  n6 -->|"1"| n18
  n6 -->|"5"| n19
  n7 -->|"35"| n4
  n7 -->|"10"| n6
  n7 -->|"25"| n15
  n7 -->|"4"| n16
  n8 -->|"1"| n6
  n8 -->|"2"| n9
  n8 -->|"1"| n15
  n8 -->|"1"| n18
  n9 -->|"1"| n6
  n9 -->|"6"| n14
  n10 -->|"1"| n6
  n11 -->|"2"| n6
  n11 -->|"5"| n15
  n12 -->|"2"| n6
  n12 -->|"2"| n16
  n13 -->|"1"| n4
  n13 -->|"3"| n6
  n13 -->|"5"| n10
  n13 -->|"5"| n14
  n13 -->|"1"| n15
  n13 -->|"2"| n19
  n14 -->|"3"| n4
  n14 -->|"4"| n6
  n14 -->|"8"| n16
  n15 -->|"13"| n4
  n15 -->|"2"| n6
  n15 -->|"1"| n7
  n15 -->|"1"| n9
  n15 -->|"1"| n14
  n16 -->|"3"| n6
  n17 -->|"1"| n6
  n19 -->|"1"| n4
  n20 -->|"1"| n18
```

## python 模块调用图

箭头表示调用方 → 被调用方，数字是扫描得到的跨模块调用边数；模块内部调用省略。无跨模块边的模块仍保留。

注意：Python 上游按方法名称猜测目标，不是精确的类型/import 解析。以下仅为候选调用图；已从图中排除 670 条跨独立服务的候选边，原始 JSON 保留。服务内部也可能存在同名误匹配。

```mermaid
flowchart LR
  n0["backend/license_admin (144 functions)"]
  n1["services/eye_tracking/adapters (449 functions)"]
  n2["services/eye_tracking/analysis (14 functions)"]
  n3["services/eye_tracking/application (166 functions)"]
  n4["services/eye_tracking/domain (10 functions)"]
  n5["services/eye_tracking/entrypoints (6 functions)"]
  n6["services/eye_tracking/infrastructure (41 functions)"]
  n7["services/eye_tracking/transport (42 functions)"]
  n8["services/facial_analysis (11 functions)"]
  n9["services/facial_analysis/application (25 functions)"]
  n10["services/facial_analysis/transport (2 functions)"]
  n1 -->|"8"| n3
  n1 -->|"9"| n4
  n1 -->|"3"| n6
  n1 -->|"13"| n7
  n2 -->|"3"| n1
  n2 -->|"4"| n3
  n3 -->|"140"| n1
  n3 -->|"1"| n2
  n3 -->|"27"| n6
  n3 -->|"5"| n7
  n5 -->|"9"| n1
  n5 -->|"3"| n6
  n5 -->|"2"| n7
  n6 -->|"39"| n1
  n6 -->|"7"| n3
  n6 -->|"3"| n4
  n6 -->|"2"| n7
  n7 -->|"18"| n1
  n7 -->|"1"| n2
  n7 -->|"62"| n3
  n7 -->|"1"| n4
  n7 -->|"1"| n6
  n8 -->|"1"| n9
```

