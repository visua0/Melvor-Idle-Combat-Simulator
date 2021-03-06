/*  Melvor Idle Combat Simulator

    Copyright (C) <2020>  <Coolrox95>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
/// <reference path="../typedefs.js" />

(() => {

    /** @type {CombatSimulator} */
    let combatSimulator;

    onmessage = (event) => {
        switch (event.data.action) {
            case 'RECEIVE_GAMEDATA':
                combatSimulator = new CombatSimulator(event.data);
                break;
            case 'START_SIMULATION':
                const startTime = performance.now();
                combatSimulator.simulateMonster(event.data.enemyStats, event.data.playerStats, event.data.simOptions.trials, event.data.simOptions.maxActions, event.data.simOptions.forceFullSim).then((simResult) => {
                    const timeTaken = performance.now() - startTime;
                    postMessage({
                        action: 'FINISHED_SIM',
                        monsterID: event.data.monsterID,
                        simResult: simResult,
                        selfTime: timeTaken
                    });
                });
                break;
            case 'CANCEL_SIMULATION':
                combatSimulator.cancelSimulation();
                break;
        }
    };

    onerror = (error) => {
        postMessage({
            action: 'ERR_SIM',
            error: error,
        });
    }

    // TODO move these globals
    let combatTriangle;
    let protectFromValue;
    let numberMultiplier;
    let enemySpecialAttacks;
    let enemySpawnTimer;
    let hitpointRegenInterval;
    let deadeyeAmulet;
    let confettiCrossbow;
    let CURSEIDS;

    class CombatSimulator {
        constructor(data) {
            /**
             * [playerType][enemyType]
             * 0:Melee 1:Ranged 2:Magic
             */
            combatTriangle = {
                normal: {
                    damageModifier: [
                        [1, 1.1, 0.9],
                        [0.9, 1, 1.1],
                        [1.1, 0.9, 1],
                    ],
                    reductionModifier: [
                        [1, 1.25, 0.5],
                        [0.95, 1, 1.25],
                        [1.25, 0.85, 1],
                    ],
                },
                hardcore: {
                    damageModifier: [
                        [1, 1.1, 0.8],
                        [0.8, 1, 1.1],
                        [1.1, 0.8, 1],
                    ],
                    reductionModifier: [
                        [1, 1.25, 0.25],
                        [0.75, 1, 1.25],
                        [1.25, 0.75, 1],
                    ],
                },
            };
            this.cancelStatus = false;
            protectFromValue = data.protectFromValue;
            numberMultiplier = data.numberMultiplier;
            enemySpecialAttacks = data.enemySpecialAttacks;
            enemySpawnTimer = data.enemySpawnTimer;
            hitpointRegenInterval = data.hitpointRegenInterval;
            deadeyeAmulet = data.deadeyeAmulet;
            confettiCrossbow = data.confettiCrossbow;
            CURSEIDS = data.CURSEIDS;
        }

        /**
         * Simulation Method for a single monster
         * @param {EnemyStats} enemyStats
         * @param {PlayerStats} playerStats
         * @param {number} trials
         * @param {number} maxActions
         * @return {Promise<Object>}
         */
        async simulateMonster(enemyStats, playerStats, trials, maxActions, forceFullSim) {
            // configure some additional default values for the `playerStats` and `enemyStats` objects
            playerStats.isPlayer = true;
            playerStats.damageTaken = 0;
            playerStats.damageHealed = 0;
            playerStats.deaths = 0;
            playerStats.ate = 0;
            playerStats.highestDamageTaken = 0;
            playerStats.lowestHitpoints = playerStats.maxHitpoints;
            enemyStats.isPlayer = false;
            enemyStats.damageTaken = 0;
            enemyStats.damageHealed = 0;
            // copy slayer area values to player stats
            playerStats.slayerArea = enemyStats.slayerArea;
            playerStats.slayerAreaEffectValue = enemyStats.slayerAreaEffectValue;

            // Start Monte Carlo simulation
            let enemyKills = 0;

            // Stats from the simulation
            const stats = {
                totalTime: 0,
                playerAttackCalls: 0,
                enemyAttackCalls: 0,
                totalCombatXP: 0,
                totalHpXP: 0,
                totalPrayerXP: 0,
                gpGainedFromDamage: 0,
                playerActions: 0,
                enemyActions: 0,
                /** @type {PetRolls} */
                petRolls: {Prayer: {}, other: {}},
                spellCasts: 0,
                curseCasts: 0,
            };

            setAreaEffects(playerStats);

            if (!playerStats.isMelee && enemyStats.passiveID.includes(2)) {
                return {simSuccess: false, reason: 'wrong style'};
            }
            if (!playerStats.isRanged && enemyStats.passiveID.includes(3)) {
                return {simSuccess: false, reason: 'wrong style'};
            }
            if (!playerStats.isMagic && enemyStats.passiveID.includes(4)) {
                return {simSuccess: false, reason: 'wrong style'};
            }
            if (enemyStats.passiveID.includes(2) || enemyStats.passiveID.includes(3)) {
                // can't curse these monsters
                playerStats.canCurse = false;
            }

            // Start simulation for each trial
            this.cancelStatus = false;
            const player = {};
            // set initial regen interval
            player.regenTimer = Math.floor(Math.random() * hitpointRegenInterval);
            // Set Combat Triangle
            if (playerStats.hardcore) {
                player.reductionModifier = combatTriangle.hardcore.reductionModifier[playerStats.attackType][enemyStats.attackType];
                player.damageModifier = combatTriangle.hardcore.damageModifier[playerStats.attackType][enemyStats.attackType];
            } else {
                player.reductionModifier = combatTriangle.normal.reductionModifier[playerStats.attackType][enemyStats.attackType];
                player.damageModifier = combatTriangle.normal.damageModifier[playerStats.attackType][enemyStats.attackType];
            }
            // Multiply player max hit
            playerStats.maxHit = Math.floor(playerStats.maxHit * player.damageModifier);
            const enemy = {};
            let innerCount = 0;
            let tooManyActions = 0;
            while (enemyKills < trials) {
                // Reset Timers and statuses
                resetPlayer(player, playerStats);
                // regen timer is not reset ! add respawn time to regen, and regen if required
                player.regenTimer -= enemySpawnTimer;
                if (player.regenTimer <= 0) {
                    regen(player, playerStats);
                }
                resetEnemy(enemy, enemyStats);
                if (playerStats.canCurse) {
                    setEnemyCurseValues(enemy, playerStats.curseID, playerStats.curseData.effectValue);
                }
                // Set accuracy based on protection prayers or stats
                setAccuracy(player, playerStats, enemy, enemyStats);
                setAccuracy(enemy, enemyStats, player, playerStats);
                // set action speed
                calculateSpeed(player, playerStats);
                player.actionTimer = player.currentSpeed;
                calculateSpeed(enemy, enemyStats);
                enemy.actionTimer = enemy.currentSpeed;

                // Simulate combat until enemy is dead or max actions has been reached
                enemy.alive = true;
                player.alive = true;
                while (enemy.alive && player.alive) {
                    innerCount++
                    // Check Cancellation every 100000th loop
                    if (innerCount % 100000 === 0 && await this.isCanceled()) {
                        return {simSuccess: false, reason: 'cancelled'};
                    }
                    // check player action limit
                    if (player.actionsTaken > maxActions) {
                        break;
                    }

                    // Determine the time step
                    let timeStep = Infinity;
                    timeStep = determineTimeStep(player, timeStep);
                    timeStep = determineTimeStep(enemy, timeStep);

                    // exit on invalid time step
                    if (timeStep <= 0) {
                        return {
                            simSuccess: false,
                            reason: 'invalid time step: ' + timeStep,
                            playerActing: player.isActing,
                            playerActionTimer: player.actionTimer,
                            playerAttacking: player.isAttacking,
                            playerAttackTimer: player.attackTimer,
                            enemyActing: enemy.isActing,
                            enemyActionTimer: enemy.actionTimer,
                            enemyAttacking: enemy.isAttacking,
                            enemyAttackTimer: enemy.attackTimer,
                            player: player,
                            enemy: enemy,
                            monsterID: enemyStats.monsterID,
                        };
                    }
                    // combat time tracker
                    stats.totalTime += timeStep;

                    processTimeStep(player, timeStep);
                    processTimeStep(enemy, timeStep);

                    if (player.regenTimer <= 0) {
                        regen(player, playerStats);
                    }

                    if (enemy.alive && player.isActing) {
                        if (player.actionTimer <= 0) {
                            playerAction(stats, player, playerStats, enemy, enemyStats);
                            // Multi attack once more when the monster died on the first hit
                            if (!enemy.alive && player.isAttacking && player.attackCount < player.countMax) {
                                stats.totalTime += player.attackInterval;
                            }
                        }
                    }
                    if (enemy.alive && player.isAttacking) {
                        if (player.attackTimer <= 0) {
                            playerContinueAction(stats, player, playerStats, enemy, enemyStats);
                        }
                    }
                    if (enemy.alive && player.isBurning) {
                        if (player.burnTimer <= 0) {
                            actorBurn(player, playerStats);
                        }
                    }
                    if (enemy.alive && player.isRecoiling) {
                        if (player.recoilTimer <= 0) {
                            actorRecoilCD(player);
                        }
                    }
                    if (enemy.alive && player.isBleeding) {
                        if (player.bleedTimer <= 0) {
                            targetBleed(enemy, enemyStats, player, playerStats);
                        }
                    }
                    //enemy
                    if (enemy.alive && enemy.isActing) {
                        if (enemy.actionTimer <= 0) {
                            enemyAction(stats, player, playerStats, enemy, enemyStats);
                        }
                    }
                    if (enemy.alive && enemy.isAttacking) {
                        if (enemy.attackTimer <= 0) {
                            enemyContinueAction(stats, player, playerStats, enemy, enemyStats);
                        }
                    }
                    if (enemy.alive && enemy.isBurning) {
                        if (enemy.burnTimer <= 0) {
                            actorBurn(enemy, enemyStats);
                        }
                    }
                    if (enemy.alive && enemy.isRecoiling) {
                        if (enemy.recoilTimer <= 0) {
                            actorRecoilCD(enemy);
                        }
                    }
                    if (enemy.alive && enemy.isBleeding) {
                        if (enemy.bleedTimer <= 0) {
                            targetBleed(player, playerStats, enemy, enemyStats);
                        }
                    }
                }
                if (isNaN(player.hitpoints) || isNaN(enemy.hitpoints)) {
                    return {
                        simSuccess: false,
                        reason: 'bogus player or enemy hp',
                        monsterID: enemyStats.monsterID,
                        playerStats: {...playerStats},
                        player: {...player},
                        enemyStats: {...enemyStats},
                        enemy: {...enemy},
                    };
                }
                if (player.hitpoints <= 0) {
                    playerStats.deaths++;
                } else if (enemy.hitpoints > 0) {
                    tooManyActions++;
                    if (!forceFullSim) {
                        return {
                            simSuccess: false,
                            reason: 'too many actions',
                            monsterID: enemyStats.monsterID,
                        }
                    }
                }
                enemyKills++;
            }

            // Apply XP Bonuses
            // Ring bonus
            stats.totalCombatXP += stats.totalCombatXP * playerStats.xpBonus;
            stats.totalHpXP += stats.totalHpXP * playerStats.xpBonus;
            // TODO: this matches the bugged behaviour of 0.18?613 of Melvor Idle
            stats.totalPrayerXP += stats.totalPrayerXP * playerStats.xpBonus / 2;
            // Global XP Bonus
            stats.totalCombatXP *= playerStats.globalXPMult;
            stats.totalHpXP *= playerStats.globalXPMult;
            stats.totalPrayerXP *= playerStats.globalXPMult;

            // Final Result from simulation
            return simulationResult(stats, playerStats, enemyStats, trials, tooManyActions);
        };

        /**
         * Checks if the simulation has been messaged to be cancelled
         * @return {Promise<boolean>}
         */
        async isCanceled() {
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve(this.cancelStatus);
                });
            });
        }

        cancelSimulation() {
            this.cancelStatus = true;
        }
    }

    function determineTimeStep(actor, timeStep) {
        if (actor.isActing) {
            timeStep = Math.min(timeStep, actor.actionTimer);
        }
        if (actor.isAttacking) {
            timeStep = Math.min(timeStep, actor.attackTimer);
        }
        if (actor.isBurning) {
            timeStep = Math.min(timeStep, actor.burnTimer);
        }
        if (actor.isRecoiling) {
            timeStep = Math.min(timeStep, actor.recoilTimer);
        }
        if (actor.isBleeding) {
            timeStep = Math.min(timeStep, actor.bleedTimer);
        }
        // only the player has regen
        if (actor.isPlayer) {
            timeStep = Math.min(timeStep, actor.regenTimer);
        }
        return timeStep;
    }

    function processTimeStep(actor, timeStep) {
        if (actor.isActing) {
            actor.actionTimer -= timeStep;
        }
        if (actor.isAttacking) {
            actor.attackTimer -= timeStep;
        }
        if (actor.isBurning) {
            actor.burnTimer -= timeStep;
        }
        if (actor.isRecoiling) {
            actor.recoilTimer -= timeStep;
        }
        if (actor.isBleeding) {
            actor.bleedTimer -= timeStep;
        }
        if (actor.isPlayer) {
            actor.regenTimer -= timeStep;
        }
        return timeStep;
    }

    function regen(player, playerStats) {
        healDamage(player, playerStats, playerStats.avgHPRegen);
        player.regenTimer += hitpointRegenInterval;
    }

    function actorRecoilCD(actor) {
        actor.canRecoil = true;
        actor.isRecoiling = false;
    }

    function actorBurn(actor, actorStats) {
        // reset timer
        actor.burnTimer = actor.burnInterval;
        // Check if stopped burning
        if (actor.burnCount >= actor.burnMaxCount) {
            actor.isBurning = false;
            return;
        }
        // Apply burn damage
        dealDamage(actor, actorStats, actor.burnDamage);
        actor.burnCount++;
    }

    function targetBleed(actor, actorStats, target, targetStats) {
        // reset timer
        target.bleedTimer = target.bleedInterval;
        // Check if stopped bleeding
        if (target.bleedCount >= target.bleedMaxCount) {
            target.isBleeding = false;
            return;
        }
        // Apply bleed damage
        dealDamage(target, targetStats, target.bleedDamage);
        target.bleedCount++;
        // Elder Crown life steals bleed damage
        if (actor.isPlayer && actorStats.activeItems.elderCrown) {
            healDamage(actor, actorStats, target.bleedDamage);
        }
    }

    function enemyAction(stats, player, playerStats, enemy, enemyStats) {
        stats.enemyActions++;
        // Do enemy action
        if (skipsTurn(enemy)) {
            return;
        }
        stats.enemyAttackCalls++;
        // Check if doing special
        let isSpecial = false;
        enemy.specialID = -1;
        enemy.currentSpecial = {};
        if (enemyStats.hasSpecialAttack) {
            const specialRoll = Math.floor(Math.random() * 100);
            let specialChance = 0;
            for (let i = 0; i < enemyStats.specialLength; i++) {
                specialChance += enemyStats.specialAttackChances[i];
                if (specialRoll <= specialChance) {
                    enemy.specialID = enemyStats.specialIDs[i];
                    enemy.currentSpecial = enemySpecialAttacks[enemy.specialID];
                    isSpecial = true;
                    break;
                }
            }
            // don't stack active buffs
            if (enemy.activeBuffs && enemy.currentSpecial.activeBuffs) {
                enemy.specialID = -1;
                enemy.currentSpecial = {};
                isSpecial = false;
            }
            // stop Ahrenia Phase 3 from using a normal attack
            if (!isSpecial && enemyStats.monsterID === 149) {
                enemy.specialID = 50;
                enemy.currentSpecial = enemySpecialAttacks[50];
                isSpecial = true;
            }
        }
        if (isSpecial) {
            setupMultiAttack(enemy, player);
        }
        enemyDoAttack(player, playerStats, enemy, enemyStats, isSpecial);
        postAttack(enemy, enemyStats, player, playerStats);
        multiAttackTimer(enemy);
    }

    function setupMultiAttack(actor, target) {
        let special = actor.currentSpecial;
        let attackCount = special.attackCount;
        let attackInterval;
        // Set up subsequent hits if required
        if (target.isPlayer && (actor.specialID === 47 || actor.specialID === 48)) {
            attackCount += target.markOfDeathStacks;
            target.removeMarkOfDeath = true;
        }
        attackInterval = special.attackInterval;
        if (special.setDOTDamage || special.setDOTHeal) {
            attackCount = special.DOTMaxProcs;
            attackInterval = special.DOTInterval;
        }
        if (attackCount === 1) {
            return;
        }
        // setup multi attack
        actor.attackCount = 0;
        actor.countMax = attackCount;
        actor.isAttacking = true;
        actor.isActing = false;
        actor.attackInterval = attackInterval;
        actor.attackTimer = attackInterval;
    }

    function enemyContinueAction(stats, player, playerStats, enemy, enemyStats) {
        // Do enemy multi attacks
        if (skipsTurn(enemy)) {
            return;
        }
        stats.enemyAttackCalls++;
        enemyDoAttack(player, playerStats, enemy, enemyStats, true);
        postAttack(enemy, enemyStats, player, playerStats);
        multiAttackTimer(enemy);
        if (!enemy.isAttacking && enemy.intoTheMist) {
            enemy.intoTheMist = false;
            enemy.increasedDamageReduction = 0;
        }
        if (!enemy.isAttacking && player.removeMarkOfDeath) {
            player.markOfDeath = false;
            player.removeMarkOfDeath = false;
            player.markOfDeathTurns = 0;
            player.markOfDeathStacks = 0;
        }
    }

    function multiAttackTimer(actor) {
        actor.attackCount++;
        // set up timer for next attack
        if (actor.isAttacking && actor.attackCount < actor.countMax) {
            // next attack is multi attack
            actor.attackTimer = actor.attackInterval;
        } else {
            // next attack is normal attack
            actor.isAttacking = false;
            actor.isActing = true;
            actor.actionTimer = actor.currentSpeed;
        }
    }

    function canNotDodge(target) {
        return target.isStunned || target.isSleeping;
    }

    function applyStatus(statusEffect, damage, actorStats, target, targetStats) {
        ////////////
        // turned //
        ////////////
        // Enemy Passive Effect "Purity" (passiveID 0) prevents stuns and sleep (same difference)
        let stunImmunity = !target.isPlayer && targetStats.passiveID.includes(0);
        // Apply Stun
        if (canApplyStatus(statusEffect.canStun, target.isStunned, statusEffect.stunChance, stunImmunity)) {
            applyStun(statusEffect, target);
        }
        // Apply Sleep
        if (canApplyStatus(statusEffect.canSleep, target.isSleeping, undefined, stunImmunity)) {
            applySleep(statusEffect, target);
        }
        // Apply Slow
        if (canApplyStatus(statusEffect.attackSpeedDebuff, target.isSlowed)) {
            target.isSlowed = true;
            target.attackSpeedDebuffTurns = statusEffect.attackSpeedDebuffTurns;
            target.attackSpeedDebuff = statusEffect.attackSpeedDebuff;
            calculateSpeed(target, targetStats);
        }
        ///////////
        // timed //
        ///////////
        // Apply Burning
        if (canApplyStatus(statusEffect.burnDebuff, target.isBurning)) {
            target.isBurning = true;
            target.burnCount = 0;
            target.burnDamage = Math.floor((target.maxHitpoints * (statusEffect.burnDebuff / 100)) / target.burnMaxCount);
            target.burnTimer = target.burnInterval;
        }
        // Apply Bleeding
        if (canApplyStatus(statusEffect.canBleed, target.isBleeding, statusEffect.bleedChance)) {
            applyBleeding(statusEffect, damage, target);
        }
        ////////////
        // debuff //
        ////////////
        // mark of death
        if (statusEffect.markOfDeath) {
            target.markOfDeath = true;
            target.removeMarkOfDeath = false;
            if (target.markOfDeathStacks <= 0) {
                target.markOfDeathTurns = 3;
            }
            if (target.markOfDeathStacks < 3) {
                target.markOfDeathStacks++;
            }
        }
        // evasion debuffs
        if (statusEffect.applyDebuffs && !target.activeDebuffs) {
            target.activeDebuffs = true;
            if (statusEffect.applyDebuffTurns !== null && statusEffect.applyDebuffTurns !== undefined) {
                target.debuffTurns = statusEffect.applyDebuffTurns;
            } else {
                target.debuffTurns = 2;
            }
            if (statusEffect.meleeEvasionDebuff) {
                target.meleeEvasionDebuff = statusEffect.meleeEvasionDebuff;
            }
            if (statusEffect.rangedEvasionDebuff) {
                target.rangedEvasionDebuff = statusEffect.rangedEvasionDebuff;
            }
            if (statusEffect.magicEvasionDebuff) {
                target.magicEvasionDebuff = statusEffect.magicEvasionDebuff;
            }
        }
        // accuracy debuffs
        if (statusEffect.decreasePlayerAccuracy !== undefined) {
            if (statusEffect.decreasePlayerAccuracyStack) {
                target.decreasedAccuracy += statusEffect.decreasePlayerAccuracy;
                target.decreasedAccuracy = Math.min(target.decreasedAccuracy, statusEffect.decreasePlayerAccuracyLimit);
            } else {
                target.decreasedAccuracy += statusEffect.decreasePlayerAccuracy;
            }
        }
    }

    function canApplyStatus(can, is, chance, immunity = false) {
        if (!can || is || immunity) {
            return false;
        }
        if (chance !== undefined) {
            const stunRoll = Math.random() * 100;
            return chance > stunRoll;
        }
        return true;
    }

    function applyStun(statusEffect, target) {
        // apply new stun
        target.isStunned = true;
        target.stunTurns = statusEffect.stunTurns;
        target.isAttacking = false;
        target.isActing = true;
        target.actionTimer = target.currentSpeed;
    }

    function applySleep(statusEffect, target) {
        // apply new sleep
        target.isSleeping = true;
        target.sleepTurns = statusEffect.sleepTurns;
        target.isAttacking = false;
        target.isActing = true;
        target.actionTimer = target.currentSpeed;
    }

    function applyBleeding(statusEffect, damage, target) {
        //apply new bleed
        target.isBleeding = true;
        target.bleedMaxCount = statusEffect.bleedCount;
        target.bleedInterval = statusEffect.bleedInterval;
        target.bleedTimer = target.bleedInterval;
        target.bleedCount = 0;
        let totalBleedDamage = 1;
        if (statusEffect.totalBleedHP > 0) {
            // bleed for `statusEffect.totalBleedHP` times initial damage
            totalBleedDamage = damage * statusEffect.totalBleedHP;
            if (statusEffect.totalBleedHPCustom === 1) {
                // bleed for up to `statusEffect.totalBleedHP` times initial damage
                totalBleedDamage *= Math.random();
            }
        } else {
            // bleed for `statusEffect.totalBleedHPPercent` % of max HP
            totalBleedDamage = target.maxHitpoints * statusEffect.totalBleedHPPercent / 100;
        }
        target.bleedDamage = Math.floor(totalBleedDamage / statusEffect.bleedCount);
    }

    function enemyDoAttack(player, playerStats, enemy, enemyStats, isSpecial) {
        let forceHit = false;
        let currentSpecial = enemy.currentSpecial;
        if (isSpecial) {
            // Do Enemy Special
            // Activate Buffs
            if (currentSpecial.activeBuffs && !enemy.activeBuffs) {
                enemy.activeBuffs = true;
                if (currentSpecial.activeBuffTurns !== null && currentSpecial.activeBuffTurns !== undefined) {
                    enemy.buffTurns = currentSpecial.activeBuffTurns;
                } else {
                    enemy.buffTurns = currentSpecial.attackCount;
                }
                // set increased attack speed buff
                if (currentSpecial.increasedAttackSpeed) {
                    enemy.increasedAttackSpeed = currentSpecial.increasedAttackSpeed;
                    calculateSpeed(enemy, enemyStats);
                }
                // Set evasion buffs
                if (currentSpecial.increasedMeleeEvasion) {
                    enemy.meleeEvasionBuff = 1 + currentSpecial.increasedMeleeEvasion / 100;
                }
                if (currentSpecial.increasedRangedEvasion) {
                    enemy.rangedEvasionBuff = 1 + currentSpecial.increasedRangedEvasion / 100;
                }
                if (currentSpecial.increasedMagicEvasion) {
                    enemy.magicEvasionBuff = 1 + currentSpecial.increasedMagicEvasion / 100;
                }
                // set reflect attack buff
                if (currentSpecial.reflectMelee) {
                    enemy.reflectMelee = currentSpecial.reflectMelee;
                }
                if (currentSpecial.reflectRanged) {
                    enemy.reflectRanged = currentSpecial.reflectRanged;
                }
                if (currentSpecial.reflectMagic) {
                    enemy.reflectMagic = currentSpecial.reflectMagic;
                }
                // set increased DR buff
                if (currentSpecial.increasedDamageReduction) {
                    enemy.increasedDamageReduction = currentSpecial.increasedDamageReduction;
                }
                // update player accuracy
                setAccuracy(player, playerStats, enemy, enemyStats);
            }
            forceHit = currentSpecial.forceHit;
        }
        // Do the first hit
        let attackHits;
        if (canNotDodge(player) || forceHit) {
            attackHits = true;
        } else {
            // Roll for hit
            const hitChance = Math.floor(Math.random() * 100);
            attackHits = enemy.accuracy > hitChance;
        }

        if (attackHits) {
            //////////////////
            // apply damage //
            //////////////////
            const damage = enemyCalculateDamage(enemy, enemyStats, player, playerStats, isSpecial, currentSpecial);
            dealDamage(player, playerStats, damage);
            //////////////////
            // side effects //
            //////////////////
            // life steal
            if (isSpecial && currentSpecial.lifesteal) {
                healDamage(enemy, enemyStats, damage * currentSpecial.lifestealMultiplier);
            }
            if (isSpecial && currentSpecial.setDOTHeal) {
                enemy.intoTheMist = true;
                healDamage(enemy, enemyStats, currentSpecial.setDOTHeal * enemy.maxHitpoints / currentSpecial.DOTMaxProcs);
            }
            // player recoil
            if (player.canRecoil) {
                let reflectDamage = 0;
                if (playerStats.activeItems.goldSapphireRing) {
                    reflectDamage += Math.floor(Math.random() * 3 * numberMultiplier);
                }
                if (playerStats.reflectDamage) {
                    reflectDamage += damage * playerStats.reflectDamage / 100
                }
                if (enemy.hitpoints > reflectDamage && reflectDamage > 0) {
                    dealDamage(enemy, enemyStats, reflectDamage);
                    player.canRecoil = false;
                    player.isRecoiling = true;
                    player.recoilTimer = 2000;
                }
            }
            // confusion curse
            if (enemy.isCursed && enemy.curse.type === 'Confusion' && !enemy.isAttacking) {
                dealDamage(enemy, enemyStats, Math.floor(enemy.hitpoints * enemy.curse.confusionMult));
            }
            // status effects
            if (isSpecial) {
                applyStatus(currentSpecial, damage, enemyStats, player, playerStats)
            }
        }
        return currentSpecial;
    }

    function calculateSpeed(actor, actorStats) {
        // base
        let speed = actorStats.attackSpeed;
        // guardian amulet
        if (actor.isPlayer && actorStats.activeItems.guardianAmulet) {
            // Guardian Amulet gives 20% increase in attack speed (TODO: 40% increase and +5% DR if below 50% HP)
            if (actor.hitpoints < actor.maxHitpoints / 2) {
                speed = Math.floor(speed * 1.4);
            } else {
                speed = Math.floor(speed * 1.2);
            }
        }
        // pet and gear reductions
        if (actorStats.decreasedAttackSpeed) {
            speed -= actorStats.decreasedAttackSpeed
        }
        // dark waters
        if (actor.isPlayer && actorStats.slayerArea === 10) {
            speed = Math.floor(speed * (1 + calculateAreaEffectValue(actorStats.slayerAreaEffectValue, actorStats) / 100));
        }
        // slow
        speed = Math.floor(speed * (1 + actor.attackSpeedDebuff / 100));
        // increased attack speed buff
        speed = Math.floor(speed * (1 - actor.increasedAttackSpeed / 100));
        // update actor current speed
        actor.currentSpeed = speed;
    }

    function postAttack(actor, actorStats, target, targetStats) {
        // Buff tracking
        if (actor.activeBuffs) {
            actor.buffTurns--;
            if (actor.buffTurns <= 0) {
                actor.activeBuffs = false;
                // Undo buffs
                actor.increasedAttackSpeed = 0;
                calculateSpeed(actor, actorStats)
                actor.meleeEvasionBuff = 1;
                actor.rangedEvasionBuff = 1;
                actor.magicEvasionBuff = 1;
                actor.reflectMelee = 0;
                actor.reflectRanged = 0;
                actor.reflectMagic = 0;
                actor.increasedDamageReduction = 0;
                setAccuracy(target, targetStats, actor, actorStats);
            }
        }
        // Slow Tracking
        if (actor.isSlowed) {
            actor.attackSpeedDebuffTurns--;
            if (actor.attackSpeedDebuffTurns <= 0) {
                actor.isSlowed = false;
                actor.attackSpeedDebuff = 0;
                calculateSpeed(actor, actorStats)
            }
        }
        // Curse Tracking
        if (actor.isCursed) {
            enemyCurseUpdate(target, targetStats, actor, actorStats);
        }
        // if target is into the mist, then increase its DR
        if (target.intoTheMist) {
            target.increasedDamageReduction += 10;
        }
    }

    function enemyCurseUpdate(player, playerStats, enemy, enemyStats) {
        // don't curse
        if (enemy.isAttacking) {
            return;
        }
        // Apply decay
        if (enemy.curse.type === 'Decay') {
            dealDamage(enemy, enemyStats, enemy.curse.decayDamage);
        }
        // reduce remaining curse turns
        enemy.curseTurns--;
        if (enemy.curseTurns > 0) {
            return;
        }
        // no curse turns remaining, revert stat changes
        enemy.isCursed = false;
        switch (enemy.curse.type) {
            case 'Blinding':
                setAccuracy(enemy, enemyStats, player, playerStats);
                break;
            case 'Soul Split':
            case 'Decay':
                setAccuracy(player, playerStats, enemy, enemyStats);
                break;
            case 'Weakening':
                enemy.maxHit = enemyStats.maxHit;
                break;
        }
    }

    function skipsTurn(actor) {
        // reduce stun
        if (actor.isStunned) {
            actor.stunTurns--;
            if (actor.stunTurns <= 0) {
                actor.isStunned = false;
            }
            actor.actionTimer = actor.currentSpeed;
            return true
        }
        // reduce sleep
        if (actor.isSleeping) {
            actor.sleepTurns--;
            if (actor.sleepTurns <= 0) {
                actor.isSleeping = false;
                actor.sleepTurns = 0;
            }
            actor.actionTimer = actor.currentSpeed;
            return true
        }
    }

    function playerAction(stats, player, playerStats, enemy, enemyStats) {
        // player action: reduce stun count or attack
        stats.playerActions++;
        if (skipsTurn(player)) {
            return;
        }
        // attack
        player.actionsTaken++;
        // track rune usage
        if (playerStats.usingMagic) {
            stats.spellCasts++;
        }
        // determine special or normal attack
        let isSpecial = false;
        player.currentSpecial = {};
        if (playerStats.usingAncient) {
            isSpecial = true;
            player.currentSpecial = playerStats.specialData[0];
        } else if (playerStats.hasSpecialAttack) {
            const specialRoll = Math.floor(Math.random() * 100);
            let specialChance = 0;
            for (const special of playerStats.specialData) {
                // Roll for player special
                specialChance += special.chance;
                if (specialRoll <= specialChance) {
                    isSpecial = true;
                    player.currentSpecial = special;
                    break;
                }
            }
        }
        if (isSpecial) {
            setupMultiAttack(player, enemy);
        }
        const attackResult = playerDoAttack(stats, player, playerStats, enemy, enemyStats, isSpecial)
        processPlayerAttackResult(attackResult, stats, player, playerStats, enemy, enemyStats);
        postAttack(player, playerStats, enemy, enemyStats);
        multiAttackTimer(player);
    }

    function playerContinueAction(stats, player, playerStats, enemy, enemyStats) {
        // perform continued attack
        if (skipsTurn(player)) {
            return;
        }
        const attackResult = playerDoAttack(stats, player, playerStats, enemy, enemyStats, true);
        processPlayerAttackResult(attackResult, stats, player, playerStats, enemy, enemyStats);
        postAttack(player, playerStats, enemy, enemyStats);
        multiAttackTimer(player);
    }

    function healDamage(target, targetStats, damage) {
        const amt = Math.floor(Math.min(damage, target.maxHitpoints - target.hitpoints));
        target.hitpoints += amt;
        target.hitpoints = Math.min(target.hitpoints, target.maxHitpoints);
        targetStats.damageHealed += amt;
        if (target.isPlayer && targetStats.activeItems.guardianAmulet) {
            updateGuardianAmuletEffect(target, targetStats);
        }
    }

    function dealDamage(target, targetStats, damage) {
        targetStats.damageTaken += Math.floor(Math.min(damage, target.hitpoints));
        target.hitpoints -= Math.floor(damage);
        // Check for Phoenix Rebirth
        if (!target.isPlayer && targetStats.passiveID.includes(1) && target.hitpoints <= 0) {
            let random = Math.random() * 100;
            if (random < 40) {
                target.hitpoints = targetStats.maxHitpoints;
            }
        }
        // update alive status
        target.alive = target.hitpoints > 0;
        // Check for player eat
        if (target.isPlayer) {
            if (target.alive) {
                autoEat(target, targetStats);
                if (targetStats.autoEat.manual && targetStats.foodHeal > 0) {
                    // TODO: use a more detailed manual eating simulation?
                    target.hitpoints = target.maxHitpoints;
                }
                if (target.hitpoints < targetStats.lowestHitpoints) {
                    targetStats.lowestHitpoints = target.hitpoints;
                }
                if (targetStats.activeItems.guardianAmulet) {
                    updateGuardianAmuletEffect(target, targetStats);
                }
            }
            if (damage > targetStats.highestDamageTaken) {
                targetStats.highestDamageTaken = damage;
            }
        }
    }

    function updateGuardianAmuletEffect(player, playerStats) {
        if (player.hitpoints < player.maxHitpoints / 2 && !player.guardianAmuletBelow) {
            player.increasedDamageReduction += 5;
            player.guardianAmuletBelow = true;
        } else if (player.hitpoints >= player.maxHitpoints / 2 && player.guardianAmuletBelow) {
            player.increasedDamageReduction -= 5;
            player.guardianAmuletBelow = false;
        }
        calculateSpeed(player, playerStats);
    }

    function autoEat(player, playerStats) {
        if (playerStats.autoEat.eatAt <= 0 || playerStats.foodHeal <= 0) {
            return;
        }
        const eatAt = playerStats.autoEat.eatAt / 100 * player.maxHitpoints;
        if (player.hitpoints > eatAt) {
            return;
        }
        const maxHP = playerStats.autoEat.maxHP / 100 * player.maxHitpoints;
        const healAmt = Math.floor(playerStats.foodHeal * playerStats.autoEat.efficiency / 100);
        const heals = Math.ceil((maxHP - player.hitpoints) / healAmt);
        playerStats.ate += heals;
        player.hitpoints += heals * healAmt;
        player.hitpoints = Math.min(player.hitpoints, player.maxHitpoints);
    }

    function processPlayerAttackResult(attackResult, stats, player, playerStats, enemy, enemyStats) {
        if (!attackResult.attackHits) {
            // attack missed, nothing to do
            return;
        }
        // damage
        dealDamage(enemy, enemyStats, Math.floor(attackResult.damageToEnemy));
        // XP Tracking
        if (attackResult.damageToEnemy > 0) {
            let xpToAdd = attackResult.damageToEnemy / numberMultiplier * 4;
            if (xpToAdd < 4) {
                xpToAdd = 4;
            }
            stats.totalHpXP += attackResult.damageToEnemy / numberMultiplier * 1.33;
            stats.totalPrayerXP += attackResult.damageToEnemy * playerStats.prayerXpPerDamage;
            stats.totalCombatXP += xpToAdd;
            if (playerStats.prayerXpPerDamage > 0) {
                stats.petRolls.Prayer[player.currentSpeed] = (stats.petRolls.Prayer[player.currentSpeed] || 0) + 1;
            }
        }
        if (attackResult.isSpecial) {
            applyStatus(attackResult.statusEffect, attackResult.damageToEnemy, playerStats, enemy, enemyStats)
        }
    }

    function playerUsePreAttackSpecial(player, playerStats, enemy, enemyStats) {
        if (playerStats.isMelee && player.currentSpecial.decreasedMeleeEvasion) {
            enemy.decreasedMeleeEvasion = player.currentSpecial.decreasedMeleeEvasion;
            setAccuracy(player, playerStats, enemy, enemyStats);
        }
        if (playerStats.isRanged && player.currentSpecial.decreasedRangedEvasion) {
            enemy.decreasedRangedEvasion = player.currentSpecial.decreasedRangedEvasion;
            setAccuracy(player, playerStats, enemy, enemyStats);
        }
        if (playerStats.isMagic && player.currentSpecial.decreasedMagicEvasion) {
            enemy.decreasedMagicEvasion = player.currentSpecial.decreasedMagicEvasion;
            setAccuracy(player, playerStats, enemy, enemyStats);
        }
        if (player.currentSpecial.decreasedAccuracy && !enemy.decreasedAccuracy) {
            enemy.decreasedAccuracy = player.currentSpecial.decreasedAccuracy;
            setAccuracy(enemy, enemyStats, player, playerStats);
        }
    }

    function playerUseCurse(stats, player, playerStats, enemy, enemyStats) {
        if (!playerStats.canCurse || enemy.isCursed) {
            return;
        }
        stats.curseCasts++;
        enemy.isCursed = true;
        enemy.curseTurns = 3;
        // Update the curses that change stats
        switch (enemy.curse.type) {
            case 'Blinding':
                setAccuracy(enemy, enemyStats, player, playerStats);
                break;
            case 'Soul Split':
            case 'Decay':
                setAccuracy(player, playerStats, enemy, enemyStats);
                break;
            case 'Weakening':
                enemy.maxHit = Math.floor(enemy.maxHit * enemy.curse.maxHitDebuff);
                break;
        }
    }

    function playerDoAttack(stats, player, playerStats, enemy, enemyStats, isSpecial) {
        stats.playerAttackCalls++;
        // Apply pre-attack special effects
        if (isSpecial) {
            playerUsePreAttackSpecial(player, playerStats, enemy, enemyStats, isSpecial);
        }
        // Apply curse
        playerUseCurse(stats, player, playerStats, enemy, enemyStats);
        // default return values
        const attackResult = {
            attackHits: false,
            isSpecial: isSpecial,
            statusEffect: {},
        };
        let attackHits;
        if (canNotDodge(enemy) || (isSpecial && player.currentSpecial.forceHit)) {
            attackHits = true;
        } else {
            // Roll for hit
            let hitChance = Math.floor(Math.random() * 100);
            if (playerStats.diamondLuck) {
                const hitChance2 = Math.floor(Math.random() * 100);
                if (hitChance > hitChance2) {
                    hitChance = hitChance2;
                }
            }
            attackHits = player.accuracy > hitChance;
        }
        if (!attackHits) {
            // exit early
            return attackResult;
        }
        // roll for pets
        stats.petRolls.other[player.currentSpeed] = (stats.petRolls.other[player.currentSpeed] || 0) + 1;
        // calculate damage
        attackResult.damageToEnemy = playerCalculateDamage(player, playerStats, enemy, enemyStats, isSpecial);
        // reflect melee damage
        if (enemy.reflectMelee) {
            dealDamage(player, playerStats, enemy.reflectMelee * numberMultiplier);
        }
        if (enemy.reflectRanged) {
            dealDamage(player, playerStats, enemy.reflectRanged * numberMultiplier);
        }
        if (enemy.reflectMagic) {
            dealDamage(player, playerStats, enemy.reflectMagic * numberMultiplier);
        }
        ////////////////////
        // status effects //
        ////////////////////
        let statusEffect = {...player.currentSpecial};
        // Fighter amulet stun overrides special attack stun
        if (playerStats.activeItems.fighterAmulet && playerStats.isMelee && attackResult.damageToEnemy >= playerStats.maxHit * 0.70) {
            statusEffect.canStun = true;
            statusEffect.stunChance = undefined;
            statusEffect.stunTurns = 1;
        }
        // life steal
        let lifeSteal = 0;
        if (isSpecial && player.currentSpecial.healsFor) {
            lifeSteal += player.currentSpecial.healsFor * 100;
        }
        if (playerStats.spellHeal && playerStats.isMagic) {
            lifeSteal += playerStats.spellHeal;
        }
        if (playerStats.lifesteal !== 0) {
            // fervor + passive item stat
            lifeSteal += playerStats.lifesteal;
        }
        if (lifeSteal > 0) {
            healDamage(player, playerStats, attackResult.damageToEnemy * lifeSteal / 100)
        }
        // confetti crossbow
        if (playerStats.activeItems.confettiCrossbow) {
            // Add gp from this weapon
            let gpMultiplier = playerStats.startingGP / 25000000;
            if (gpMultiplier > confettiCrossbow.gpMultiplierCap) {
                gpMultiplier = confettiCrossbow.gpMultiplierCap;
            } else if (gpMultiplier < confettiCrossbow.gpMultiplierMin) {
                gpMultiplier = confettiCrossbow.gpMultiplierMin;
            }
            if (playerStats.activeItems.aorpheatsSignetRing) {
                gpMultiplier *= 2;
            }
            stats.gpGainedFromDamage += Math.floor(attackResult.damageToEnemy * gpMultiplier);
        }

        // return the result of the attack
        attackResult.attackHits = true;
        attackResult.statusEffect = statusEffect;
        return attackResult;
    }

    function enemyCalculateDamage(enemy, enemyStats, player, playerStats, isSpecial, currentSpecial) {
        let damage = setDamage(enemy, enemyStats, player, playerStats, isSpecial, currentSpecial);
        if (damage === undefined) {
            damage = Math.floor(Math.random() * enemy.maxHit) + 1;
        }
        return applyDamageModifiers(damage, enemy, player, isSpecial, currentSpecial);
    }

    function setDamage(actor, actorStats, target, targetStats, isSpecial, currentSpecial) {
        if (!isSpecial) {
            return undefined;
        }
        let damage = undefined;
        let cbTriangleAlreadyApplied = false;
        // check if any set damage cases apply
        if (currentSpecial.setHPDamage !== undefined) {
            const setHPDamage = currentSpecial.setHPDamage / 100 * actor.hitpoints;
            damage = Math.floor(Math.random() * setHPDamage + 10);
        } else if (currentSpecial.customDamageModifier !== undefined) {
            damage = Math.floor(targetStats.maxHit * (1 - currentSpecial.customDamageModifier / 100));
        } else if (currentSpecial.setDamage !== null && currentSpecial.setDamage !== undefined) {
            damage = currentSpecial.setDamage * numberMultiplier;
        } else if (isSpecial && currentSpecial.maxHit) {
            damage = actorStats.maxHit;
            cbTriangleAlreadyApplied = true;
        } else if (isSpecial && currentSpecial.stormsnap) {
            damage = (6 + 6 * actorStats.levels.Magic);
        } else {
            return undefined
        }
        // cb triangle damage modifier
        if (!cbTriangleAlreadyApplied && actor.damageModifier) {
            damage *= actor.damageModifier;
        }
        return damage;
    }

    // stun, sleep and DR apply to fixed damage
    function applyDamageModifiers(damage, actor, target, isSpecial, special) {
        if (isSpecial && target.isStunned) {
            damage *= special.stunDamageMultiplier;
        }
        if (isSpecial && target.isSleeping) {
            damage *= special.sleepDamageMultiplier;
        }
        let damageReduction = target.damageReduction + target.increasedDamageReduction;
        if (target.markOfDeath) {
            damageReduction = Math.floor(damageReduction / 2);
        }
        if (target.isPlayer) {
            damageReduction = Math.floor(damageReduction * target.reductionModifier);
        }
        damage -= Math.floor((damageReduction / 100) * damage);
        return damage;
    }

    function playerCalculateDamage(player, playerStats, enemy, enemyStats, isSpecial) {
        let damage = setDamage(player, playerStats, enemy, enemyStats, isSpecial, player.currentSpecial);
        // Calculate attack Damage
        if (damage === undefined) {
            // roll hit based on max hit, max hit already takes cb triangle into account !
            if (player.alwaysMaxHit) {
                damage = playerStats.maxHit;
            } else {
                damage = rollForDamage(playerStats);
            }
        }
        if (isSpecial && player.currentSpecial.damageMultiplier) {
            damage *= player.currentSpecial.damageMultiplier;
        }
        // player specific modifiers
        if (enemy.isCursed && enemy.curse.type === 'Anguish') {
            damage *= enemy.curse.damageMult;
        }
        if (playerStats.activeItems.deadeyeAmulet && playerStats.isRanged) {
            damage *= critDamageModifier(damage);
        }
        if (playerStats.isSlayerTask && playerStats.activeItems.slayerSkillcape) {
            damage *= 1.05;
        }
        // common modifiers
        damage = applyDamageModifiers(damage, player, enemy, isSpecial, player.currentSpecial)
        // cap damage, no overkill
        if (enemy.hitpoints < damage) {
            damage = enemy.hitpoints;
        }
        return damage;
    }

    function resetCommonStats(common, stats) {
        common.currentSpecial = {};
        // action
        common.isActing = true;
        common.attackTimer = 0;
        common.isAttacking = false;
        // stun
        common.isStunned = false;
        common.stunTurns = 0;
        // sleep
        common.isSleeping = false;
        common.sleepTurns = 0;
        // bleed
        common.bleedTimer = 0;
        common.isBleeding = false;
        common.bleedMaxCount = 0;
        common.bleedInterval = 0;
        common.bleedCount = 0;
        common.bleedDamage = 0;
        // burn
        common.burnTimer = 0;
        common.isBurning = false;
        common.burnMaxCount = 10;
        common.burnCount = 0;
        common.burnDamage = 0;
        common.burnInterval = 500;
        // slow
        common.isSlowed = false;
        common.attackSpeedDebuffTurns = 0;
        common.attackSpeedDebuff = 0;
        common.increasedAttackSpeed = 0;
        // buff
        common.activeBuffs = false;
        common.buffTurns = 0;
        common.increasedDamageReduction = 0;
        // curse
        common.isCursed = false;
        common.curseTurns = 0;
        //recoil
        common.canRecoil = true;
        common.isRecoiling = false;
        common.recoilTimer = 0;
        // multi attack
        common.attackCount = 0;
        common.countMax = 0;
        // debuffs
        common.magicEvasionDebuff = 0;
        common.meleeEvasionDebuff = 0;
        common.rangedEvasionDebuff = 0;
        common.decreasedAccuracy = 0;
        // hp
        common.maxHitpoints = stats.maxHitpoints;
    }

    function resetPlayer(player, playerStats) {
        resetCommonStats(player, playerStats);
        player.isPlayer = true;
        if (!player.hitpoints || player.hitpoints <= 0) {
            player.hitpoints = playerStats.maxHitpoints;
        }
        player.damageReduction = playerStats.damageReduction;
        if (playerStats.activeItems.guardianAmulet) {
            player.guardianAmuletBelow = false;
            updateGuardianAmuletEffect(player, playerStats);
        }
        player.actionsTaken = 0;
        player.alwaysMaxHit = playerStats.minHit + 1 >= playerStats.maxHit; // Determine if player always hits for maxHit
    }


    function resetEnemy(enemy, enemyStats) {
        resetCommonStats(enemy, enemyStats);
        enemy.isPlayer = false;
        enemy.hitpoints = enemyStats.maxHitpoints;
        enemy.damageReduction = 0;
        enemy.reflectMelee = 0;
        enemy.reflectRanged = 0;
        enemy.reflectMagic = 0;
        enemy.specialID = null;
        enemy.attackInterval = 0;
        enemy.maxAttackRoll = enemyStats.maxAttackRoll;
        enemy.maxHit = enemyStats.maxHit;
        enemy.maxDefRoll = enemyStats.maxDefRoll;
        enemy.maxMagDefRoll = enemyStats.maxMagDefRoll;
        enemy.maxRngDefRoll = enemyStats.maxRngDefRoll;
        enemy.decreasedRangedEvasion = 0;
        enemy.meleeEvasionBuff = 1;
        enemy.magicEvasionBuff = 1;
        enemy.rangedEvasionBuff = 1;
        enemy.attackType = enemyStats.attackType;
        enemy.curse = {};
    }

    function simulationResult(stats, playerStats, enemyStats, trials, tooManyActions) {
        /** @type {MonsterSimResult} */
        const simResult = {
            simSuccess: true,
            petRolls: {},
            tooManyActions: tooManyActions,
            monsterID: enemyStats.monsterID,
        };

        simResult.xpPerHit = stats.totalCombatXP / stats.playerAttackCalls;
        // xp per second
        const totalTime = (trials - tooManyActions) * enemySpawnTimer + stats.totalTime;
        simResult.xpPerSecond = stats.totalCombatXP / totalTime * 1000;
        simResult.hpXpPerSecond = stats.totalHpXP / totalTime * 1000;
        simResult.prayerXpPerSecond = stats.totalPrayerXP / totalTime * 1000;
        // resource use
        // pp
        simResult.ppConsumedPerSecond = stats.playerAttackCalls * playerStats.prayerPointsPerAttack / totalTime * 1000;
        simResult.ppConsumedPerSecond += stats.enemyAttackCalls * playerStats.prayerPointsPerEnemy / totalTime * 1000;
        simResult.ppConsumedPerSecond += playerStats.prayerPointsPerHeal / hitpointRegenInterval * 1000;
        // hp
        let damage = playerStats.damageTaken;
        damage -= playerStats.damageHealed;
        simResult.hpPerSecond = Math.max(0, damage / totalTime * 1000);
        // attacks
        simResult.attacksTakenPerSecond = stats.enemyAttackCalls / totalTime * 1000;
        simResult.attacksMadePerSecond = stats.playerAttackCalls / totalTime * 1000;
        // ammo
        simResult.ammoUsedPerSecond = playerStats.isRanged ? simResult.attacksMadePerSecond : 0;
        simResult.ammoUsedPerSecond *= 1 - playerStats.ammoPreservation / 100;
        // runes
        simResult.spellCastsPerSecond = stats.spellCasts / totalTime * 1000;
        simResult.curseCastsPerSecond = stats.curseCasts / totalTime * 1000;
        // damage
        simResult.avgHitDmg = enemyStats.damageTaken / stats.playerAttackCalls;
        simResult.dmgPerSecond = enemyStats.damageTaken / totalTime * 1000;
        // deaths and extreme damage
        simResult.deathRate = playerStats.deaths / (trials - tooManyActions);
        simResult.highestDamageTaken = playerStats.highestDamageTaken;
        simResult.lowestHitpoints = playerStats.lowestHitpoints;
        if (playerStats.autoEat.manual) {
            // TODO: use a more detailed manual eating simulation?
            simResult.atePerSecond = Math.max(0, damage / playerStats.foodHeal / totalTime * 1000);
        } else {
            simResult.atePerSecond = playerStats.ate / totalTime * 1000;
        }
        if (!isFinite(simResult.atePerSecond)) {
            simResult.atePerSecond = NaN;
        }
        // gp
        simResult.gpFromDamagePerSecond = stats.gpGainedFromDamage / totalTime * 1000;

        // stats depending on kills
        const successes = trials - playerStats.deaths;
        if (tooManyActions === 0 && successes) {
            // kill time
            simResult.avgKillTime = totalTime / successes;
            simResult.killTimeS = simResult.avgKillTime / 1000;
            simResult.killsPerSecond = 1 / simResult.killTimeS;
        } else {
            // kill time
            simResult.avgKillTime = NaN;
            simResult.killTimeS = NaN;
            simResult.killsPerSecond = 0;
        }

        // Throw pet rolls in here to be further processed later
        Object.keys(stats.petRolls).forEach((petType) =>
            simResult.petRolls[petType] = Object.keys(stats.petRolls[petType]).map(attackSpeed => ({
                speed: parseInt(attackSpeed),
                rollsPerSecond: stats.petRolls[petType][attackSpeed] / totalTime * 1000,
            }))
        );
        // return successful results
        return simResult;
    }

    // TODO: duplicated in injectable/Simulator.js
    /**
     * Sets the accuracy of actor vs target
     * @param {Object} actor
     * @param {number} actor.attackType Attack Type Melee:0, Ranged:1, Magic:2
     * @param {number} actor.maxAttackRoll Accuracy Rating
     * @param {Object} target
     * @param {number} target.maxDefRoll Melee Evasion Rating
     * @param {number} target.maxRngDefRoll Ranged Evasion Rating
     * @param {number} target.maxMagDefRoll Magic Evasion Rating
     */
    function setAccuracy(actor, actorStats, target, targetStats) {
        // if target is player using protection prayer: return early
        if (target.isPlayer && targetStats.isProtected) {
            actor.accuracy = 100 - protectFromValue;
            return;
        }
        // determine attack roll
        let maxAttackRoll = actorStats.maxAttackRoll;
        if (actor.decreasedAccuracy) {
            maxAttackRoll = Math.floor(maxAttackRoll * (1 - actor.decreasedAccuracy / 100));
        }
        if (actor.isCursed && actor.curse.accuracyDebuff) {
            maxAttackRoll = Math.floor(maxAttackRoll * actor.curse.accuracyDebuff);
        }
        // handle player and enemy cases
        if (target.isPlayer) {
            setEvasionDebuffsPlayer(target, targetStats);
        } else {
            // Adjust ancient magick forcehit
            if (actorStats.usingAncient && (actorStats.specialData[0].forceHit || actorStats.specialData[0].checkForceHit)) {
                actorStats.specialData[0].forceHit = maxAttackRoll > 20000;
                actorStats.specialData[0].checkForceHit = true;
            }
            setEvasionDebuffsEnemy(target, targetStats);
        }
        // determine relevant defence roll
        let targetDefRoll;
        if (actorStats.isMelee) {
            targetDefRoll = target.maxDefRoll;
        } else if (actorStats.isRanged) {
            targetDefRoll = target.maxRngDefRoll;
        } else {
            targetDefRoll = target.maxMagDefRoll;
        }
        // accuracy based on attack roll and defence roll
        let acc;
        if (maxAttackRoll < targetDefRoll) {
            acc = (0.5 * maxAttackRoll / targetDefRoll) * 100;
        } else {
            acc = (1 - 0.5 * targetDefRoll / maxAttackRoll) * 100;
        }
        actor.accuracy = acc;
    }

    /**
     * Modifies the stats of the enemy by the curse
     * @param {Object} enemy
     * @param {number} curseID
     * @param {number|number[]} effectValue
     */
    function setEnemyCurseValues(enemy, curseID, effectValue) {
        switch (curseID) {
            case CURSEIDS.Blinding_I:
            case CURSEIDS.Blinding_II:
            case CURSEIDS.Blinding_III:
                enemy.curse.accuracyDebuff = 1 - effectValue / 100;
                enemy.curse.type = 'Blinding';
                break;
            case CURSEIDS.Soul_Split_I:
            case CURSEIDS.Soul_Split_II:
            case CURSEIDS.Soul_Split_III:
                enemy.curse.magicEvasionDebuff = 1 - effectValue / 100;
                enemy.curse.type = 'Soul Split';
                break;
            case CURSEIDS.Weakening_I:
            case CURSEIDS.Weakening_II:
            case CURSEIDS.Weakening_III:
                enemy.curse.maxHitDebuff = 1 - effectValue / 100;
                enemy.curse.type = 'Weakening';
                break;
            case CURSEIDS.Anguish_I:
            case CURSEIDS.Anguish_II:
            case CURSEIDS.Anguish_III:
                enemy.curse.damageMult = 1 + effectValue / 100;
                enemy.curse.type = 'Anguish';
                break;
            case CURSEIDS.Decay:
                enemy.curse.meleeEvasionDebuff = 1 - effectValue[1] / 100;
                enemy.curse.magicEvasionDebuff = 1 - effectValue[1] / 100;
                enemy.curse.rangedEvasionDebuff = 1 - effectValue[1] / 100;
                enemy.curse.decayDamage = Math.floor(enemy.hitpoints * effectValue[0] / 100);
                enemy.curse.type = 'Decay';
                break;
            case CURSEIDS.Confusion:
                enemy.curse.confusionMult = effectValue / 100;
                enemy.curse.type = 'Confusion';
                break;
        }
    }

    /**
     * Rolls for damage for a regular attack
     * @param {playerStats} playerStats
     * @returns {number} damage
     */
    function rollForDamage(playerStats) {
        return Math.ceil(Math.random() * (playerStats.maxHit - playerStats.minHit)) + playerStats.minHit;
    }

    /**
     * Rolls for a chance of Deadeye Amulet's crit damage
     * @param {damageToEnemy} damageToEnemy
     * @returns {damageToEnemy} `damageToEnemy`, possibly multiplied by Deadeye Amulet's crit bonus
     */
    function critDamageModifier(damageToEnemy) {
        const chance = Math.random() * 100;
        if (chance < deadeyeAmulet.chanceToCrit) {
            return deadeyeAmulet.critDamage;
        }
        return 1;
    }

    /**
     * Modifies the stats of the enemy by the curse
     * @param {enemyStats} enemyStats
     * @param {Object} enemy
     */
    function setEvasionDebuffsEnemy(enemy, enemyStats) {
        const isCursed = enemy.isCursed && (enemy.curse.type === 'Decay' || enemy.curse.type === 'Soul Split');
        enemy.maxDefRoll = calculateEnemyEvasion(enemyStats.maxDefRoll, enemy.decreasedMeleeEvasion, enemy.meleeEvasionBuff, isCursed ? enemy.curse.meleeEvasionDebuff : 0);
        enemy.maxRngDefRoll = calculateEnemyEvasion(enemyStats.maxRngDefRoll, enemy.decreasedRangedEvasion, enemy.rangedEvasionBuff, isCursed ? enemy.curse.rangedEvasionDebuff : 0);
        enemy.maxMagDefRoll = calculateEnemyEvasion(enemyStats.maxMagDefRoll, enemy.decreasedMagicEvasion, enemy.magicEvasionBuff, isCursed ? enemy.curse.magicEvasionDebuff : 0);
    }

    function calculateEnemyEvasion(initial, decreasedEvasion, evasionBuff, curseEvasionDebuff) {
        let maxRoll = initial;
        if (decreasedEvasion) {
            maxRoll = Math.floor(maxRoll * (1 - decreasedEvasion / 100));
        }
        if (evasionBuff) {
            maxRoll = Math.floor(maxRoll * evasionBuff);
        }
        if (curseEvasionDebuff) {
            maxRoll = Math.floor(maxRoll * curseEvasionDebuff);
        }
        return maxRoll
    }

    function setEvasionDebuffsPlayer(player, playerStats) {
        let areaEvasionDebuff = 0;
        if (playerStats.slayerArea === 9 /*Perilous Peaks*/) {
            areaEvasionDebuff = calculateAreaEffectValue(playerStats.slayerAreaEffectValue, playerStats);
        }
        player.maxDefRoll = calculatePlayerEvasion(playerStats.maxDefRoll, player.meleeEvasionBuff, player.meleeEvasionDebuff + areaEvasionDebuff);
        player.maxRngDefRoll = calculatePlayerEvasion(playerStats.maxRngDefRoll, player.rangedEvasionBuff, player.rangedEvasionDebuff + areaEvasionDebuff);
        if (playerStats.slayerArea === 6 /*Runic Ruins*/ && !playerStats.isMagic) {
            areaEvasionDebuff = calculateAreaEffectValue(playerStats.slayerAreaEffectValue, playerStats);
        }
        player.maxMagDefRoll = calculatePlayerEvasion(playerStats.maxMagDefRoll, player.magicEvasionBuff, player.magicEvasionDebuff + areaEvasionDebuff);
    }

    function calculatePlayerEvasion(initial, evasionBuff, evasionDebuff) {
        let maxRoll = initial;
        if (evasionBuff) {
            maxRoll = Math.floor(maxRoll * (1 + evasionBuff / 100));
        }
        maxRoll = Math.floor(maxRoll * (1 - evasionDebuff / 100));
        return maxRoll
    }

    // Slayer area effect value
    function calculateAreaEffectValue(base, playerStats) {
        let value = Math.floor(base * (1 - playerStats.slayerAreaEffectNegationPercent / 100));
        value -= playerStats.slayerAreaEffectNegationFlat;
        if (value < 0) {
            value = 0;
        }
        return value;
    }

    function setAreaEffects(playerStats) {
        // 0: "Penumbra" - no area effect
        // 1: "Strange Cave" - no area effect
        // 2: "High Lands" - no area effect
        // 3: "Holy Isles" - no area effect
        // 4: "Forest of Goo" - no area effect
        // 5: "Desolate Plains" - no area effect
        // 6: "Runic Ruins" - reduced evasion rating -> implemented in setEvasionDebuffsPlayer
        // 7: "Arid Plains" - reduced food efficiency -> TODO: implement this when tracking player HP
        // 8: "Shrouded Badlands"
        if (playerStats.slayerArea === 8 /*Shrouded Badlands*/) {
            playerStats.maxAttackRoll = Math.floor(playerStats.maxAttackRoll * (1 - calculateAreaEffectValue(playerStats.slayerAreaEffectValue, playerStats) / 100));
        }
        // 9: "Perilous Peaks" - reduced evasion rating -> implemented in setEvasionDebuffsPlayer
        // 10: "Dark Waters" - reduced player attack speed -> implemented in calculateSpeed
    }

})();