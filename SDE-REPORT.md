# EVE Online 静态数据（SDE）分析报告

> 分析对象：`./eve-online-static-data`
> 数据版本：`buildNumber 3660036`，`releaseDate 2026-10-29T11:10:30Z`
> 生成时间：2026-10-30

---

## 一、总体概况

| 项 | 值 |
| --- | --- |
| 文件数 | 102 个 `.jsonl` |
| 总体积 | 553.8 MB |
| 总行数 | 约 676,900 行 |
| 平均行长 | 约 820 字节（`types.jsonl` 平均 2.8 KB/行，最长；`missions.jsonl` 平均 18 KB/行） |
| 支持语言 | 8 种：`zh` `en` `ja` `ru` `de` `fr` `ko` `es` |
| 格式 | JSON Lines，每行一个完整 JSON 对象 |

### 数据格式特征

1. **主键固定为 `_key`**，但类型不统一：绝大多数是数字 ID，少数是字符串（`translationLanguages` 用语言码，`skinrTierThresholds` 用阈值）。
2. **文本字段是多语言对象**：`"name": {"en": "...", "zh": "...", ...}`，取中文需 `name.zh ?? name.en`。
3. **字段稀疏**：同一张表里不同条目字段差异极大（舰船没有 `portionSize`，弹药没有 `capacity`），反序列化必须全部可选。
4. **深嵌套**：`blueprints.activities` 是「活动 → 材料/产物/时间」多层结构；`mapMoons.attributes/statistics` 是对象/数组。
5. **必须流式解析**：多个文件单行超长，禁止一次性 `readFileSync` 整个文件。

### 规模 Top 10

| 文件 | 行数 | 体积 |
| --- | --- | --- |
| `mapMoons.jsonl` | 344,457 | 213.6 MB |
| `types.jsonl` | 53,292 | 146.9 MB |
| `missions.jsonl` | 2,892 | 50.9 MB |
| `mapPlanets.jsonl` | 68,407 | 48.6 MB |
| `typeDogma.jsonl` | 26,927 | 26.4 MB |
| `mapAsteroidBelts.jsonl` | 40,928 | 20.7 MB |
| `npcCharacters.jsonl` | 11,393 | 6.2 MB |
| `mapSolarSystems.jsonl` | 8,490 | 4.9 MB |
| `blueprints.jsonl` | 5,100 | 3.4 MB |
| `typeBonus.jsonl` | 653 | 3.2 MB |

> 前 6 个文件占总体积 **93%**。其中 `mapMoons` + `mapPlanets` + `mapAsteroidBelts`（月球/行星/小行星带）合计 283 MB（51%），与大部分工具型功能无关。

---

## 二、按领域分类（全部 102 个文件）

### A. 元数据（2 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `_sde.jsonl` | 1 | 0.1 KB | `_key,buildNumber,releaseDate` | 版本清单，用于判断是否需增量更新 |
| `translationLanguages.jsonl` | 8 | 0.3 KB | `_key,name` | 支持的 8 种语言代码 |

### B. 物品类型体系（核心，12 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `types.jsonl` | 53,292 | 146.9 MB | `groupID,marketGroupID,name,description,mass,volume,capacity,basePrice,metaGroupID,metaLevel,techLevel,iconID,graphicID,radius,portionSize,published,raceID,factionID,variationParentTypeID,shipTreeGroupID,soundID,isRepackable` | **物品总表**，全库核心。分类、体积、价格、科技层级都在这里 |
| `groups.jsonl` | 1,611 | 788.5 KB | `categoryID,name,iconID,published,fittableNonSingleton,anchorable,anchored,useBasePrice` | 物品分组（护卫舰、弹药…） |
| `categories.jsonl` | 48 | 10.8 KB | `name,iconID,published` | 顶级分类（舰船/模块/弹药/建材…） |
| `metaGroups.jsonl` | 13 | 5.5 KB | `name,color,iconID,iconSuffix,description` | 科技元组（Tech I/II/III、势力、死亡空间） |
| `marketGroups.jsonl` | 2,114 | 1.5 MB | `name,description,parentGroupID,hasTypes,iconID` | **市场分类树**，`parentGroupID` 自引用 |
| `icons.jsonl` | 4,806 | 446.5 KB | `iconFile` | 图标文件清单（`iconID` → 文件路径） |
| `graphics.jsonl` | 6,072 | 812.7 KB | `graphicFile,iconFolder,sofFactionName,sofHullName,sofRaceName` | 3D 模型/渲染资源映射 |
| `graphicMaterialSets.jsonl` | 953 | 552.1 KB | `colorHull,colorPrimary,colorSecondary,colorWindow,material1..4` | 材质配色集 |
| `typeElements.jsonl` | 424 | 61.1 KB | `elements` | 类型的 UI 元素定义 |
| `typeLists.jsonl` | 472 | 125.6 KB | `includedTypeIDs,includedGroupIDs,includedCategoryIDs,excluded*` | 类型集合（按 ID 规则圈定一批物品） |
| `compressibleTypes.jsonl` | 212 | 8.9 KB | `compressedTypeID` | 压缩矿石/气体 → 压缩产物 |
| `typeMaterials.jsonl` | 9,566 | 2.2 MB | `materials[{typeID,quantity}]` | 精炼/回收产出表 |

### C. 属性系统 dogma（9 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `typeDogma.jsonl` | 26,927 | 26.4 MB | `dogmaAttributes[{attributeID,value}],dogmaEffects` | 每个物品的属性值 |
| `dogmaAttributes.jsonl` | 2,871 | 1.2 MB | `attributeCategoryID,dataType,defaultValue,name,displayName,unitID,highIsGood,stackable,iconID` | 属性定义字典 |
| `dogmaEffects.jsonl` | 3,427 | 2.0 MB | `effectCategoryID,modifierInfo,durationAttributeID,rangeAttributeID,isAssistance,isOffensive,isWarpSafe` | 效果定义字典 |
| `dogmaAttributeCategories.jsonl` | 37 | 3.2 KB | `name,description` | 属性分组 |
| `dogmaUnits.jsonl` | 60 | 25.4 KB | `name,displayName,description` | 单位（HP、m、s、%） |
| `dynamicItemAttributes.jsonl` | 441 | 174.5 KB | `attributeIDs,inputOutputMapping` | 动态属性 |
| `typeBonus.jsonl` | 653 | 3.2 MB | `roleBonuses,miscBonuses,types,iconID` | 舰船角色加成 |
| `fighterAbilities.jsonl` | 36 | 31.1 KB | `displayName,targetMode,turretGraphicID,tooltipText` | 铁骑舰载机技能 |
| `fighterAbilitiesByType.jsonl` | 94 | 15.2 KB | `abilitySlot0..2` | 舰载机 → 技能槽映射 |

### D. 工业与制造（9 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `blueprints.jsonl` | 5,100 | 3.4 MB | `blueprintTypeID,activities{manufacturing,copying,invention,research_material,research_time},maxProductionLimit` | **蓝图全表**，含 `materials[]/products[]/time` |
| `typeMaterials.jsonl` | 9,566 | 2.2 MB | `materials[]` | 回收/精炼产出 |
| `industryActivities.jsonl` | 6 | 0.6 KB | `name,description` | 制造/研究/发明/反应活动枚举 |
| `industryAssemblyLines.jsonl` | 146 | 306.8 KB | `activityID,baseCostMultiplier,baseMaterialMultiplier,baseTimeMultiplier,detailsPerCategory/Group/TypeList` | 产线类型与系数 |
| `industryInstallationTypes.jsonl` | 102 | 12.2 KB | `assemblyLines` | 建筑可装产线 |
| `industryModifierSources.jsonl` | 220 | 41.6 KB | `manufacturing,copying,invention,reaction,researchMaterial,researchTime` | 工业系数来源 |
| `industryTargetFilters.jsonl` | 18 | 1.4 KB | `categoryIDs,groupIDs,name` | 工业目标过滤 |
| `planetSchematics.jsonl` | 68 | 30.8 KB | `cycleTime,pins,types` | 行星工业配方（P1→P4） |
| `planetResources.jsonl` | 25,798 | 1.3 MB | `power,workforce,reagent` | 行星资源分布 |
| `metenoxMoonDrill.jsonl` | 1 | 0.1 KB | `miningCycleTime,miningEfficiency,reagentsConsumedPerCycle` | 月矿钻机参数（单例） |

### E. 空间与地图（12 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `mapRegions.jsonl` | 114 | 433.3 KB | `name,constellationIDs,factionID,position,wormholeClassID,nebulaID` | 星域 |
| `mapConstellations.jsonl` | 1,184 | 471.1 KB | `name,regionID,solarSystemIDs,factionID,wormholeClassID` | 星座 |
| `mapSolarSystems.jsonl` | 8,490 | 4.9 MB | `name,securityStatus,securityClass,regionID,constellationID,starID,planetIDs,stargateIDs,position,position2D,radius,hub,border,corridor` | **星系总表**，跳跃图与安全等级基础 |
| `mapStargates.jsonl` | 13,978 | 2.8 MB | `solarSystemID,destination,typeID,position` | 星门连接关系 |
| `mapStars.jsonl` | 8,089 | 1.8 MB | `solarSystemID,typeID,radius,statistics` | 恒星 |
| `mapPlanets.jsonl` | 68,407 | 48.6 MB | `solarSystemID,moonIDs,asteroidBeltIDs,npcStationIDs,celestialIndex,orbitID,radius,statistics` | 行星 |
| `mapMoons.jsonl` | 344,457 | 213.6 MB | 同行星 + `npcStationIDs` | 卫星（全库最大文件） |
| `mapAsteroidBelts.jsonl` | 40,928 | 20.7 MB | `solarSystemID,celestialIndex,orbitID,position,radius,statistics` | 小行星带 |
| `mapSecondarySuns.jsonl` | 1,038 | 182.4 KB | `solarSystemID,typeID,effectBeaconTypeID` | 次级恒星/信标 |
| `npcStations.jsonl` | 5,210 | 1.8 MB | `solarSystemID,ownerID,operationID,typeID,reprocessingEfficiency,reprocessingStationsTake` | **NPC 空间站**（含精炼税率） |
| `landmarks.jsonl` | 45 | 307 KB | `name,description,locationID,position` | 地标 |
| `sovereigntyUpgrades.jsonl` | 49 | 6.4 KB | `fuel,power_allocation,workforce_allocation,mutually_exclusive_group` | 主权设施升级 |

### F. NPC、势力与角色（21 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `npcCorporations.jsonl` | 283 | 1.9 MB | `name,tickerName,factionID,ceoID,stationID,solarSystemID,taxRate,divisions,lpOfferTables,enemyID,friendID,size,uniqueName` | **NPC 军团**，含忠诚点商店 |
| `npcCharacters.jsonl` | 11,393 | 6.2 MB | `name,corporationID,bloodlineID,raceID,locationID,agent,skills,ceo,uniqueName` | NPC 人物/代理人 |
| `npcCorporationDivisions.jsonl` | 10 | 17.6 KB | `name,displayName,leaderTypeName` | 军团部门 |
| `factions.jsonl` | 27 | 175.1 KB | `name,corporationID,militiaCorporationID,memberRaces,sizeFactor,flatLogo,iconID` | 势力 |
| `races.jsonl` | 11 | 30.6 KB | `name,shipTypeID,skills,iconID` | 种族与初始舰 |
| `bloodlines.jsonl` | 18 | 72.6 KB | 属性点 + `corporationID,raceID` | 血统 |
| `ancestries.jsonl` | 43 | 155.6 KB | 属性点 + `bloodlineID` | 血统分支 |
| `agentTypes.jsonl` | 13 | 0.5 KB | `name` | 代理人类型 |
| `agentsInSpace.jsonl` | 360 | 36 KB | `typeID,solarSystemID,dungeonID,spawnPointID` | 场景中的代理人 |
| `characterAttributes.jsonl` | 5 | 6.7 KB | `name,description,iconID` | 五大属性 |
| `cloneGrades.jsonl` | 4 | 21 KB | `name,skills` | 克隆等级 |
| `certificates.jsonl` | 139 | 567.2 KB | `name,groupID,skillTypes,recommendedFor` | 技能证书 |
| `masteries.jsonl` | 477 | 147.8 KB | `_value` | 舰船精通等级 |
| `skillPlans.jsonl` | 40 | 345.2 KB | `name,skillRequirements,milestones,careerPathID,factionID` | 官方技能规划 |
| `schools.jsonl` | 23 | 57.4 KB | `raceID,corporationID,startingStations,careerAgents` | 新手学校 |
| `schoolMap.jsonl` | 12 | 0.6 KB | `schoolID,solarSystemID` | 学校所在地 |
| `corporationRoles.jsonl` | 55 | 52.8 KB | `name,shortName,roleGroupIDs` | 军团职位 |
| `corporationRoleGroups.jsonl` | 9 | 3.9 KB | `appliesTo,appliesToGrantable,isDivisional,isLocational` | 职位分组 |
| `corporationActivities.jsonl` | 20 | 3.9 KB | `name` | 军团活动类型 |
| `characterTitles.jsonl` | 45 | 12.6 KB | `name` | 军团头衔 |
| `expertSystems.jsonl` | 59 | 86.4 KB | `durationDays,skillsGranted,associatedShipTypes,retired` | 专家系统 |

### G. 任务、副本与内容（15 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `missions.jsonl` | 2,892 | 50.9 MB | `name,messages,corporationID,factionID,missionRewards,killMission,courierMission,expirationTime,hasStandingRewards` | 任务全表（文本量极大） |
| `epicArcs.jsonl` | 21 | 27.4 KB | `name,missions,factionID,arcRestartInterval` | 史诗任务线 |
| `dungeons.jsonl` | 1,416 | 1.3 MB | `name,archetypeID,factionID,allowedShipsList` | 死亡空间/复合体 |
| `archetypes.jsonl` | 34 | 48.3 KB | `title,description` | 副本原型 |
| `militaryCampaigns.jsonl` | 4 | 173.2 KB | `title,subtitle,targetProgress` | 军事行动 |
| `militaryCampaignObjectives.jsonl` | 176 | 898.9 KB | `campaignID,careerPath,rewards,contributionMethodConfiguration` | 军事行动目标 |
| `mercenaryTacticalOperations.jsonl` | 3 | 4.6 KB | `name,dungeonID,infomorphBonus` | 雇佣兵战术行动 |
| `freelanceJobSchemas.jsonl` | 1 | 97.1 KB | `_value` | 自由职业任务模式（单例大 JSON） |
| `notificationTypes.jsonl` | 297 | 120 KB | `displayName,internalName` | ESI 通知类型字典 |
| `accountingEntryTypes.jsonl` | 177 | 166.5 KB | `name,journalMessage,internalName` | 钱包流水类型 |
| `contrabandTypes.jsonl` | 8 | 5.4 KB | `factions` | 违禁品与罚金 |
| `controlTowerResources.jsonl` | 44 | 31.5 KB | `resources` | 母星控制塔燃料 |
| `stationServices.jsonl` | 27 | 6.4 KB | `serviceName,description` | 空间站服务 |
| `stationOperations.jsonl` | 69 | 137.7 KB | `services,stationTypes,manufacturingFactor,researchFactor,ratio` | 空间站服务与税率系数 |
| `stationStandingsRestrictions.jsonl` | 1 | 0.2 KB | `services` | 声望限制（单例） |

### H. 外观、皮肤与涂装（13 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `skins.jsonl` | 7,049 | 1.2 MB | `types[],skinMaterialID,isStructureSkin,visibleTranquility/Serenity` | 皮肤主表 |
| `skinMaterials.jsonl` | 875 | 256.2 KB | `displayName,materialSetID` | 材质集 |
| `skinLicenses.jsonl` | 11,878 | 935.4 KB | `duration,licenseTypeID,skinID` | 皮肤授权 |
| `skinrComponents.jsonl` | 613 | 447.5 KB | `name,category,rarity,finish,resourceFile,associatedTypeIds` | 涂装组件（新系统） |
| `skinrComponentCategories.jsonl` | 3 | 0.1 KB | `name` | 组件分类 |
| `skinrComponentRarities.jsonl` | 6 | 1.1 KB | `name,rank` | 组件稀有度 |
| `skinrComponentPointValues.jsonl` | 3 | 0.6 KB | `_value` | 组件点数 |
| `skinrSlots.jsonl` | 8 | 2.8 KB | `allowedDesignComponentCategories,category,name` | 涂装槽位 |
| `skinrSlotNames.jsonl` | 8 | 0.3 KB | `name` | 槽位名称 |
| `skinrSlotCategories.jsonl` | 3 | 0.1 KB | `name` | 槽位分类 |
| `skinrSlotConfigurations.jsonl` | 4 | 1 KB | `allowAllShips,config,name,priority,ships` | 槽位配置 |
| `skinrSlotsToMaterials.jsonl` | 16 | 2.5 KB | `_value` | 槽位↔材质 |
| `skinrTierThresholds.jsonl` | 49 | 27.8 KB | `_value` | 等级阈值 |

### I. 舰船科技树与联动（4 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `shipTreeGroups.jsonl` | 52 | 114.6 KB | `name,elements,preReqSkills,icon/iconLarge/iconSmall` | 科技树分组 |
| `shipTreeElements.jsonl` | 30 | 37.7 KB | `description,icon,name` | 科技树节点 |
| `shipTreeFactions.jsonl` | 17 | 19.6 KB | `description,elements,icon` | 按势力组织 |
| `linkWithShip.jsonl` | 3 | 1.3 KB | `linkDuration,dbuffs,maxLinkRange,characterEnergyCost` | 舰船联动机制 |

### J. DBuff / 场景效果（5 个）

| 文件 | 行数 | 体积 | 关键字段 | 说明 |
| --- | --- | --- | --- | --- |
| `dbuffCollections.jsonl` | 277 | 179.3 KB | `aggregateMode,itemModifiers,locationModifiers,locationGroupModifiers` | 减益集合定义 |
| `appliedProximityEffects.jsonl` | 119 | 14.1 KB | `dbuffs,radius,delaySeconds` | 近场效果 |
| `systemWideEffects.jsonl` | 95 | 8.5 KB | `dbuffs,eligibleTypeListID,environmentTypeID` | 星系级效果 |
| `systemDbuffEmitters.jsonl` | 1 | 0.1 KB | `dbuffs,duration,interval` | 星系减益发生源（单例） |
| `proximityTrap.jsonl` | 24 | 5.5 KB | `triggerRange,triggerDelay,forceDecloakDuration,resetDelay` | 接近陷阱 |

**分类文件数合计**：A 2 + B 12 + C 9 + D 9 + E 12 + F 21 + G 15 + H 13 + I 4 + J 5 = **102**

---

## 三、关键 ID 关联图谱

```
categories (48)
   └─ groups.categoryID → groups (1,611)
        └─ types.groupID → types (53,292)        ← 物品总表（万能入口）
             ├─ typeDogma._key      → 属性/效果值
             ├─ typeMaterials._key  → 回收材料 [typeID, quantity]
             ├─ blueprints._key     → 制造材料/产物/时间
             ├─ typeBonus.types[]   → 舰船加成
             └─ icons._key ← types.iconID           ← 物品图标

marketGroups (2,114)  parentGroupID 自引用成树
   └─ types.marketGroupID → 市场分类（本项目「资产-分类」列取此处）

mapRegions (114)
   └─ mapConstellations.regionID (1,184)
        └─ mapSolarSystems.constellationID (8,490)
             ├─ mapStargates.solarSystemID (13,978) → destination 连成跳跃图
             ├─ mapPlanets.solarSystemID  (68,407)  → moonIDs / asteroidBeltIDs
             ├─ mapMoons / mapAsteroidBelts (344,457 / 40,928)
             └─ npcStations.solarSystemID (5,210)

factions (27) ─ npcCorporations.factionID (283) ─ npcCharacters.corporationID (11,393)
                                                    └─ lpOfferTables（忠诚点商店）

skins (7,049) ─ skins.types[] → types
                └─ skinMaterialID → skinMaterials (875)
```

**最核心的 4 张表**：`types` → `groups` → `categories`，以及 `marketGroups`。任何「物品 + 分类 + 名称 + 图标」需求都从这 4 个入手。

---

## 四、与本项目的结合点

### 1. 现有脚本可直接复用

`scripts/build-sde.mjs` 默认读取 `../eve-faceless-next/eve-online-static-data`，数据现位于项目根目录，直接指定路径即可：

```powershell
node scripts/build-sde.mjs eve-online-static-data
```

脚本使用的字段（`marketGroups.name.zh`、`marketGroups.parentGroupID`、`types.name.zh`、`types.marketGroupID`）与实际结构完全一致；当前 `src-tauri/resources/sde-market-groups.json`（1.5 MB，2026-10-29）即由这份数据生成。

### 2. 可低成本增强的点

| 需求 | 数据来源 | 备注 |
| --- | --- | --- |
| 物品图标 | `types.iconID` → `icons.iconFile` | 或直接用官方 CDN `https://images.evetech.net/types/{type_id}/icon?size=32` |
| 物品体积/估值 | `types.volume`、`types.basePrice`、`types.packagedVolume` | 运输体积、资产估值 |
| 制造业（当前隐藏） | `blueprints` + `typeMaterials` + `industryActivities` | 材料需递归展开（成品 → 组件 → 矿物） |
| 地图（当前隐藏） | `mapSolarSystems` + `mapStargates` + `mapRegions` | 合计约 8 MB，体积友好 |
| 市场深度筛选 | `marketGroups` + `types.metaGroupID/techLevel` | 支持「只看 Tech II / 势力装备」 |
| 舰船对比 | `typeDogma` + `dogmaAttributes` + `typeBonus` | 26 MB，建议按需提取 |

### 3. 体积与打包建议

- **不要整目录打包**：554 MB 中 `mapMoons`(213 MB)、`missions`(51 MB)、`mapPlanets`(49 MB)、`mapAsteroidBelts`(21 MB) 合计 334 MB 是纯世界细节，桌面工具用不上。
- 按用途裁剪（市场 + 类型 + 工业 + 星系 + NPC 空间站 + 图标）约 **25 MB**，gzip 后约 6–8 MB，可像现有 `sde-market-groups.json` 一样 `include_str!` 进二进制，或首次启动导入 SQLite。
- 现有 `seed_market_groups` + `market_group`/`market_type` 表就是这套做法，扩展时沿用。

### 4. 解析坑位清单

| 坑 | 说明 |
| --- | --- |
| 多语言对象 | `name`/`description` 为 map，需 `zh ?? en`；部分条目只有 `en`，且存在 `"DO NOT TRANSLATE"` 原文会混入中文名 |
| 字段稀疏 | 同表不同条目字段差异大，反序列化全部加默认值/Option |
| `_key` 类型混用 | 数字 ID 与字符串 key 并存，不能统一按 `i64` 解析 |
| 超长单行 | `types` 平均 2.8 KB/行、`missions` 平均 18 KB/行，必须流式逐行读 |
| 单例行文件 | `_sde`、`metenoxMoonDrill`、`systemDbuffEmitters`、`stationStandingsRestrictions`、`freelanceJobSchemas` 是配置型单例 |
| 冗余属性 | `typeDogma` 中大量属性为默认值，导入前应过滤，否则表膨胀数倍 |
| 版本判定 | 用 `_sde.buildNumber` 判断是否需重新导入，比文件 mtime 可靠 |

---

## 五、结论

这是一份完整的 EVE 官方 SDE 快照（2026-10-29，102 表 / 554 MB / 约 67 万行），核心是「`types` + `groups` + `categories` + `marketGroups`」构成的物品体系，外围按 dogma（属性计算）、industry（制造）、map（空间）、NPC（势力/军团）、content（任务/副本）、skin（外观）六个子系统展开。

对本项目：**只需把现有 `build-sde.mjs` 指向本目录即可满足市场分类需求**；将来实现制造业、地图、舰船对比时，再按上表分别抽取对应的 3–6 个文件，无需全量导入。
