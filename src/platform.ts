import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { S30API, LennoxSystem, LennoxZone } from 'lennoxapi';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LennoxS30Config, ThermostatConfig } from './types';
import { ThermostatAccessory } from './accessories/thermostat';
import { AwaySwitchAccessory } from './accessories/awaySwitch';
import { VentilationSwitchAccessory } from './accessories/ventilationSwitch';
import { AllergenSwitchAccessory } from './accessories/allergenSwitch';
import { OutdoorTemperatureSensor } from './accessories/outdoorSensor';

/**
 * Represents a connected thermostat
 */
interface ConnectedThermostat {
  config: ThermostatConfig;
  api: S30API;
  system: LennoxSystem;
  emptyPollCount: number;
  hasResetDuringPolling: boolean;
}

/**
 * LennoxS30Platform - Main platform plugin for Homebridge
 */
export class LennoxS30Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  // Connected thermostats
  private thermostats: ConnectedThermostat[] = [];
  // Failed thermostats to retry
  private failedThermostats: ThermostatConfig[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const lennoxConfig = this.config as LennoxS30Config;

    if (!lennoxConfig.thermostats || lennoxConfig.thermostats.length === 0) {
      this.log.error('No thermostats configured. Plugin will not start.');
      return;
    }

    this.log.info('Lennox platform initializing...');

    // Wait for Homebridge to finish launching before connecting
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });

    // Handle shutdown
    this.api.on('shutdown', () => {
      this.shutdown();
    });
  }

  /**
   * Called when a cached accessory is restored from disk
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Connect to all thermostats and discover accessories
   */
  async discoverDevices(): Promise<void> {
    const lennoxConfig = this.config as LennoxS30Config;

    // Connect to each thermostat
    for (const thermostatConfig of lennoxConfig.thermostats ?? []) {
      const success = await this.connectThermostat(thermostatConfig);
      if (!success) {
        this.failedThermostats.push(thermostatConfig);
      }
    }

    if (this.thermostats.length === 0 && this.failedThermostats.length === 0) {
      this.log.error('No thermostats configured');
      return;
    }

    // Register accessories for all connected thermostats
    this.registerAccessories();

    // Start polling loop
    this.startPolling();

    // Start retry loop for failed thermostats
    if (this.failedThermostats.length > 0) {
      this.startRetryLoop();
    }
  }

  /**
   * Connect to a single thermostat
   * Returns true if connection succeeded, false otherwise
   */
  private async connectThermostat(thermostatConfig: ThermostatConfig): Promise<boolean> {
    let s30api: S30API | null = null;
    try {
      s30api = new S30API({
        ipAddress: thermostatConfig.ipAddress,
        protocol: 'https',
      });

      const ip = thermostatConfig.ipAddress;
      this.log.info(`Connecting to thermostat at ${ip}...`);

      await s30api.serverConnect();

      const system = s30api.getSystem('LCC');
      if (!system) {
        this.log.error(`Failed to get system from ${ip}`);
        await this.safeShutdown(s30api);
        return false;
      }

      await s30api.subscribe(system);

      // Wait for configuration and zone data (like HA plugin)
      // Max 60 seconds of idle time, but poll continuously when messages arrive
      // If we get 20 consecutive idle loops with no data, reset the thermostat
      const maxIdleLoops = 60;
      const resetThreshold = 20;
      let idleLoops = 0;
      let hasResetOnce = false;
      
      this.log.info(`${ip}: Waiting for configuration data...`);
      
      while (idleLoops < maxIdleLoops) {
        const gotMessage = await s30api.messagePump();
        
        // Check if we have complete configuration and zones
        if (system.configComplete() && system.zones.length > 0) {
          break;
        }
        
        // Only count idle loops when no message was received
        if (!gotMessage) {
          idleLoops++;
          
          // If we've had too many idle loops and haven't reset yet, try resetting
          if (idleLoops === resetThreshold && !hasResetOnce) {
            this.log.warn(`${ip}: No data received after ${resetThreshold}s, resetting thermostat...`);
            try {
              await s30api.publishMessage(system.sysId, { resetLcc: { state: 'reset' } });
              hasResetOnce = true;
              // Wait for thermostat to restart
              await this.delay(30000);
              // Reconnect
              await s30api.serverConnect();
              await s30api.subscribe(system);
              idleLoops = 0; // Reset counter
              this.log.info(`${ip}: Reconnected after reset, waiting for data...`);
            } catch (resetError) {
              this.log.error(`${ip}: Reset failed:`, (resetError as Error).message);
            }
          }
          
          await this.delay(1000);
        } else {
          // Got a message, reset idle counter
          idleLoops = 0;
        }
      }

      const systemName = system.name ?? ip;
      if (!system.configComplete()) {
        this.log.warn(`${systemName}: Configuration incomplete after waiting`);
        await this.safeShutdown(s30api);
        return false;
      } else if (system.zones.length === 0) {
        this.log.warn(`${systemName}: No zones found after waiting`);
        await this.safeShutdown(s30api);
        return false;
      }

      this.log.info(`Connected to ${systemName} at ${ip} (${system.zones.length} zones)`);

      this.thermostats.push({
        config: thermostatConfig,
        api: s30api,
        system,
        emptyPollCount: 0,
        hasResetDuringPolling: false,
      });

      return true;

    } catch (error) {
      this.log.error(`Failed to connect to ${thermostatConfig.ipAddress}:`, (error as Error).message);
      if (s30api) {
        await this.safeShutdown(s30api);
      }
      return false;
    }
  }

  /**
   * Register all accessories based on configuration and detected capabilities
   */
  private registerAccessories(): void {
    for (const thermostat of this.thermostats) {
      this.registerAccessoriesForThermostat(thermostat);
    }
  }

  /**
   * Register accessories for a single thermostat (used when retrying failed connections)
   */
  private registerAccessoriesForThermostat(thermostat: ConnectedThermostat): void {
    const lennoxConfig = this.config as LennoxS30Config;
    const accessoryConfig = lennoxConfig.accessories ?? {};
    const { config: tConfig, system } = thermostat;
    const systemName = system.name ?? tConfig.ipAddress;

    // Register all active zones with HVAC capabilities
    for (const zone of system.zones) {
      if (zone.isZoneDisabled) {
        this.log.debug(`${systemName}: Zone ${zone.id} (${zone.name}) is disabled, skipping`);
        continue;
      }
      if (zone.heatingOption === null && zone.coolingOption === null) {
        this.log.debug(`${systemName}: Zone ${zone.id} (${zone.name}) has no HVAC options, skipping`);
        continue;
      }
      this.registerThermostatAccessory(systemName, zone);
    }

    // Register optional accessories
    if (accessoryConfig.awaySwitch) {
      this.registerAwaySwitchAccessory(systemName, system);
    }

    if (accessoryConfig.ventilationSwitch && system.supportsVentilation()) {
      this.registerVentilationSwitchAccessory(systemName, system);
    }

    if (accessoryConfig.allergenSwitch && system.allergenDefender !== null) {
      this.registerAllergenSwitchAccessory(systemName, system);
    }

    if (accessoryConfig.outdoorTemperature && system.outdoorTemperature !== null) {
      this.registerOutdoorTemperatureSensor(systemName, system);
    }
  }

  /**
   * Start retry loop for failed thermostats
   */
  private startRetryLoop(): void {
    const retryInterval = 60000; // Retry every 60 seconds

    this.log.info(`Will retry ${this.failedThermostats.length} failed thermostat(s) every 60s`);

    const retry = async () => {
      if (this.isShuttingDown || this.failedThermostats.length === 0) {
        return;
      }

      // Try to connect to each failed thermostat
      const stillFailed: ThermostatConfig[] = [];

      for (const config of this.failedThermostats) {
        this.log.info(`Retrying connection to ${config.ipAddress}...`);
        
        try {
          const success = await this.connectThermostat(config);

          if (success) {
            // Find the newly added thermostat and register its accessories
            const thermostat = this.thermostats.find(t => t.config.ipAddress === config.ipAddress);
            if (!thermostat) {
              this.log.error(`Reconnected to ${config.ipAddress} but could not locate thermostat entry`);
              stillFailed.push(config);
              continue;
            }

            try {
              this.registerAccessoriesForThermostat(thermostat);
              this.log.info(`Successfully reconnected to ${thermostat.system.name ?? config.ipAddress}`);
            } catch (regError) {
              this.log.error(`Failed to register accessories for ${config.ipAddress}:`, (regError as Error).message);
              await this.safeShutdown(thermostat.api);
              this.thermostats = this.thermostats.filter(t => t !== thermostat);
              stillFailed.push(config);
            }
          } else {
            stillFailed.push(config);
          }
        } catch (error) {
          this.log.error(`Unexpected error retrying ${config.ipAddress}:`, (error as Error).message);
          stillFailed.push(config);
        }
      }

      this.failedThermostats = stillFailed;

      // Schedule next retry if there are still failed thermostats
      if (this.failedThermostats.length > 0 && !this.isShuttingDown) {
        this.retryTimer = setTimeout(retry, retryInterval);
      }
    };

    // Start first retry after the interval
    this.retryTimer = setTimeout(retry, retryInterval);
  }

  /**
   * Register a thermostat accessory for a zone
   */
  private registerThermostatAccessory(systemName: string, zone: LennoxZone): void {
    // Use system name to ensure uniqueness across multiple thermostats
    const uniqueIdInput = `lennox-thermostat-${systemName}-${zone.id}`;
    const uuid = this.api.hap.uuid.generate(uniqueIdInput);
    // In central mode (single zone), just use system name; in zoned mode, append zone name
    const isCentralMode = zone.system.zoningMode !== 'zoned';
    const zoneName = zone.name ?? `Zone ${zone.id}`;
    let displayName: string;
    if (isCentralMode) {
      // Single zone - just use system name (e.g., "Downstairs")
      displayName = systemName;
    } else {
      // Multi-zone - include zone name (e.g., "Downstairs Zone 1")
      displayName = `${systemName} ${zoneName}`;
    }
    this.log.info(`Registering thermostat: ${displayName}, uniqueId=${uniqueIdInput}, UUID=${uuid}`);

    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (accessory) {
      this.log.info('Restoring thermostat from cache:', displayName);
      new ThermostatAccessory(this, accessory, zone);
    } else {
      this.log.info('Adding new thermostat:', displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      new ThermostatAccessory(this, accessory, zone);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  /**
   * Register away switch accessory
   */
  private registerAwaySwitchAccessory(systemName: string, system: LennoxSystem): void {
    // Use system name to ensure uniqueness across multiple thermostats
    const uniqueIdInput = `lennox-away-${systemName}`;
    const uuid = this.api.hap.uuid.generate(uniqueIdInput);
    const displayName = `${systemName} Away`;
    this.log.info(`Registering away switch: ${displayName}, uniqueId=${uniqueIdInput}, UUID=${uuid}`);

    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (accessory) {
      this.log.info('Restoring away switch from cache:', displayName);
      new AwaySwitchAccessory(this, accessory, system);
    } else {
      this.log.info('Adding new away switch:', displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      new AwaySwitchAccessory(this, accessory, system);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  /**
   * Register ventilation switch accessory
   */
  private registerVentilationSwitchAccessory(systemName: string, system: LennoxSystem): void {
    const uuid = this.api.hap.uuid.generate(`lennox-ventilation-${systemName}`);
    const displayName = `${systemName} Ventilation`;

    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (accessory) {
      this.log.info('Restoring ventilation switch from cache:', displayName);
      new VentilationSwitchAccessory(this, accessory, system);
    } else {
      this.log.info('Adding new ventilation switch:', displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      new VentilationSwitchAccessory(this, accessory, system);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  /**
   * Register allergen defender switch accessory
   */
  private registerAllergenSwitchAccessory(systemName: string, system: LennoxSystem): void {
    const uuid = this.api.hap.uuid.generate(`lennox-allergen-${systemName}`);
    const displayName = `${systemName} Allergen Defender`;

    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (accessory) {
      this.log.info('Restoring allergen switch from cache:', displayName);
      new AllergenSwitchAccessory(this, accessory, system);
    } else {
      this.log.info('Adding new allergen switch:', displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      new AllergenSwitchAccessory(this, accessory, system);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  /**
   * Register outdoor temperature sensor accessory
   */
  private registerOutdoorTemperatureSensor(systemName: string, system: LennoxSystem): void {
    const uuid = this.api.hap.uuid.generate(`lennox-outdoor-temp-${systemName}`);
    const displayName = `${systemName} Outdoor`;

    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (accessory) {
      this.log.info('Restoring outdoor temp sensor from cache:', displayName);
      new OutdoorTemperatureSensor(this, accessory, system);
    } else {
      this.log.info('Adding new outdoor temp sensor:', displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      new OutdoorTemperatureSensor(this, accessory, system);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  /**
   * Start the polling loop
   */
  private startPolling(): void {
    const lennoxConfig = this.config as LennoxS30Config;
    const pollInterval = (lennoxConfig.pollInterval ?? 30) * 1000;
    const maxEmptyPolls = 10; // Reset after 10 consecutive empty polls

    this.log.debug(`Starting poll loop with ${pollInterval / 1000}s interval`);

    const poll = async () => {
      if (this.isShuttingDown) return;

      // Poll all thermostats
      for (const thermostat of this.thermostats) {
        try {
          const gotMessage = await thermostat.api.messagePump();
          
          if (gotMessage) {
            // Reset empty poll counter on success
            thermostat.emptyPollCount = 0;
            thermostat.hasResetDuringPolling = false;
          } else {
            thermostat.emptyPollCount++;
            
            // If too many empty polls and haven't reset yet, try resetting
            if (thermostat.emptyPollCount >= maxEmptyPolls && !thermostat.hasResetDuringPolling) {
              const name = thermostat.system.name ?? thermostat.config.ipAddress;
              this.log.warn(`${name}: No data for ${thermostat.emptyPollCount} polls, resetting thermostat...`);
              try {
                await thermostat.api.publishMessage(thermostat.system.sysId, { resetLcc: { state: 'reset' } });
                thermostat.hasResetDuringPolling = true;
                // Wait for restart then reconnect
                await this.delay(30000);
                await thermostat.api.serverConnect();
                await thermostat.api.subscribe(thermostat.system);
                thermostat.emptyPollCount = 0;
                this.log.info(`${name}: Reconnected after reset`);
              } catch (resetError) {
                this.log.error(`${name}: Reset failed:`, (resetError as Error).message);
              }
            }
          }
        } catch (error) {
          const name = thermostat.system.name ?? thermostat.config.ipAddress;
          this.log.error(`Poll error for ${name}:`, (error as Error).message);
          thermostat.emptyPollCount++;
        }
      }

      // Schedule next poll
      if (!this.isShuttingDown) {
        this.pollTimer = setTimeout(poll, pollInterval);
      }
    };

    // Start polling
    poll();
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Safely shutdown a Lennox API instance, ignoring errors
   */
  private async safeShutdown(api: S30API): Promise<void> {
    try {
      await api.shutdown();
    } catch (err) {
      this.log.debug('Error during safe shutdown:', (err as Error).message);
    }
  }

  /**
   * Shutdown the platform
   */
  private async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    // Shutdown all thermostats
    for (const thermostat of this.thermostats) {
      try {
        await thermostat.api.shutdown();
      } catch (error) {
        const name = thermostat.system.name ?? thermostat.config.ipAddress;
        this.log.debug(`Shutdown error for ${name}:`, (error as Error).message);
      }
    }

    this.log.info('Platform shutdown complete');
  }
}
