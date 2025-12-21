import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { LennoxS30Platform } from '../platform';
import { LennoxZone } from 'lennoxapi';

// Lennox mode constants
const LENNOX_HVAC_OFF = 'off';
const LENNOX_HVAC_COOL = 'cool';
const LENNOX_HVAC_HEAT = 'heat';
const LENNOX_HVAC_HEAT_COOL = 'heat and cool';
const LENNOX_HVAC_EMERGENCY_HEAT = 'emergency heat';

// Lennox temp operation
const LENNOX_TEMP_OPERATION_OFF = 'off';
const LENNOX_TEMP_OPERATION_HEATING = 'heating';
const LENNOX_TEMP_OPERATION_COOLING = 'cooling';

/**
 * ThermostatAccessory - Exposes a Lennox zone as a HomeKit Thermostat
 */
export class ThermostatAccessory {
  private service: Service;

  constructor(
    private readonly platform: LennoxS30Platform,
    private readonly accessory: PlatformAccessory,
    private readonly zone: LennoxZone,
  ) {
    // Log zone config for debugging
    const zoneName = this.zone.name ?? `Zone ${this.zone.id}`;
    this.platform.log.info(`Thermostat ${zoneName}: config: singleSetpointMode=${this.zone.system.singleSetpointMode}, ` +
      `heatingOption=${this.zone.heatingOption}, coolingOption=${this.zone.coolingOption}`);

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Lennox')
      .setCharacteristic(this.platform.Characteristic.Model, this.zone.system.productType ?? 'S30/S40')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.zone.system.serialNumber ?? 'Unknown');

    // Get or create thermostat service
    this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    // Set display name
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.zone.name ?? `Zone ${this.zone.id}`);

    // Configure valid values based on zone capabilities
    this.configureValidValues();

    // Current state (read-only) - set initial values like HA does
    const currentTemp = this.getCurrentTemperature();
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemp);
    this.platform.log.info(`  CurrentTemperature=${currentTemp}`);

    const currentState = this.getCurrentHeatingCoolingState();
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentState);
    this.platform.log.info(`  CurrentHeatingCoolingState=${currentState}`);

    // Target state - set initial value
    const targetState = this.getTargetHeatingCoolingState();
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetState);
    this.platform.log.info(`  TargetHeatingCoolingState=${targetState} (validValues set in configureValidValues)`);

    // Target temperature (always present) - set initial value
    const targetTemp = this.getTargetTemperature();
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this))
      .setProps({
        minValue: 10,
        maxValue: 35,
        minStep: 0.5,
      });
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemp);
    this.platform.log.info(`  TargetTemperature=${targetTemp} (range 10-35)`)

    // Only add threshold characteristics if NOT in single setpoint mode
    // This matches the HA HomeKit bridge behavior - when SSP is active,
    // these characteristics are not added at all, so HomeKit uses
    // TargetTemperature even in AUTO mode
    if (!this.zone.system.singleSetpointMode) {
      const heatingThreshold = this.getHeatingThreshold();
      this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .onGet(this.getHeatingThreshold.bind(this))
        .onSet(this.setHeatingThreshold.bind(this))
        .setProps({
          minValue: 10,
          maxValue: 35,
          minStep: 0.5,
        });
      this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, heatingThreshold);
      this.platform.log.info(`  HeatingThresholdTemperature=${heatingThreshold} (range 10-35)`);

      const coolingThreshold = this.getCoolingThreshold();
      this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
        .onGet(this.getCoolingThreshold.bind(this))
        .onSet(this.setCoolingThreshold.bind(this))
        .setProps({
          minValue: 10,
          maxValue: 35,
          minStep: 0.5,
        });
      this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, coolingThreshold);
      this.platform.log.info(`  CoolingThresholdTemperature=${coolingThreshold} (range 10-35)`);
    } else {
      this.platform.log.info(`  SSP mode: NOT adding HeatingThresholdTemperature or CoolingThresholdTemperature`);
      // SSP mode: remove threshold characteristics if they exist from a cached accessory
      // This prevents HomeKit from expecting values we don't provide
      // Use testCharacteristic to check WITHOUT creating the characteristic
      if (this.service.testCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)) {
        const heatingChar = this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature);
        this.service.removeCharacteristic(heatingChar);
        this.platform.log.info(`  Removed cached HeatingThresholdTemperature`);
      }
      if (this.service.testCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)) {
        const coolingChar = this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature);
        this.service.removeCharacteristic(coolingChar);
        this.platform.log.info(`  Removed cached CoolingThresholdTemperature`);
      }
    }

    // Humidity (if available)
    if (this.zone.humidity != null) {
      const humidity = this.getCurrentHumidity();
      this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getCurrentHumidity.bind(this));
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, humidity);
      this.platform.log.info(`  CurrentRelativeHumidity=${humidity}`);
    } else {
      this.platform.log.info(`  CurrentRelativeHumidity=not available`);
    }

    // Temperature display units - set initial value
    const displayUnits = this.getDisplayUnits();
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getDisplayUnits.bind(this))
      .onSet(this.setDisplayUnits.bind(this));
    this.service.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, displayUnits);
    this.platform.log.info(`  TemperatureDisplayUnits=${displayUnits} (0=C, 1=F)`);

    // Register callbacks for push updates
    this.zone.registerOnUpdateCallback(() => {
      this.updateCharacteristics();
    }, ['temperature', 'humidity', 'systemMode', 'tempOperation', 'hsp', 'hspC', 'csp', 'cspC', 'sp', 'spC']);
  }

  /**
   * Configure valid values based on zone capabilities
   */
  private configureValidValues(): void {
    const validValues: number[] = [
      this.platform.Characteristic.TargetHeatingCoolingState.OFF,
    ];

    if (this.zone.heatingOption) {
      validValues.push(this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
    }

    if (this.zone.coolingOption) {
      validValues.push(this.platform.Characteristic.TargetHeatingCoolingState.COOL);
    }

    // Expose AUTO if both heating and cooling are available (matches HA behavior)
    if (this.zone.heatingOption && this.zone.coolingOption) {
      validValues.push(this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
    }

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues });
    this.platform.log.info(`  TargetHeatingCoolingState validValues=${JSON.stringify(validValues)} (0=OFF,1=HEAT,2=COOL,3=AUTO)`);
  }

  /**
   * Update characteristics from zone state (called via callback)
   */
  private updateCharacteristics(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.getCurrentTemperature(),
    );

    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      this.getCurrentHeatingCoolingState(),
    );

    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      this.getTargetHeatingCoolingState(),
    );

    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetTemperature,
      this.getTargetTemperature(),
    );

    // Only update threshold temperatures if they were added (non-SSP mode)
    if (!this.zone.system.singleSetpointMode) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.HeatingThresholdTemperature,
        this.getHeatingThreshold(),
      );

      this.service.updateCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature,
        this.getCoolingThreshold(),
      );
    }

    if (this.zone.humidity != null) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        this.getCurrentHumidity(),
      );
    }
  }

  /**
   * Convert Fahrenheit to Celsius
   */
  private fToC(f: number): number {
    return Math.round((f - 32) * (5 / 9) * 2) / 2;
  }

  /**
   * Check if single setpoint mode is active
   * Returns true when:
   * - System is in single setpoint mode, OR
   * - Zone is not in heat_and_cool mode (heat-only or cool-only use single temp)
   */
  private isSingleSetpointActive(): boolean {
    if (this.zone.system.singleSetpointMode) {
      return true;
    }
    // In non-SSP mode, only heat_and_cool uses dual setpoints
    return this.zone.systemMode !== LENNOX_HVAC_HEAT_COOL;
  }

  /**
   * Convert Celsius to Fahrenheit
   */
  private cToF(c: number): number {
    return Math.round((c * (9 / 5)) + 32);
  }

  /**
   * Get current temperature (Celsius)
   */
  getCurrentTemperature(): CharacteristicValue {
    let temp = 20; // Default
    if (this.zone.temperatureC !== null) {
      temp = this.zone.temperatureC;
    } else if (this.zone.temperature !== null) {
      temp = this.fToC(this.zone.temperature);
    }
    // Clamp to HomeKit valid range (0-100°C for current temp)
    return Math.max(0, Math.min(100, temp));
  }

  /**
   * Get current heating/cooling state
   */
  getCurrentHeatingCoolingState(): CharacteristicValue {
    switch (this.zone.tempOperation) {
      case LENNOX_TEMP_OPERATION_HEATING:
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      case LENNOX_TEMP_OPERATION_COOLING:
        return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      case LENNOX_TEMP_OPERATION_OFF:
      default:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  /**
   * Get target heating/cooling state
   */
  getTargetHeatingCoolingState(): CharacteristicValue {
    switch (this.zone.systemMode) {
      case LENNOX_HVAC_HEAT:
      case LENNOX_HVAC_EMERGENCY_HEAT:
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      case LENNOX_HVAC_COOL:
        return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      case LENNOX_HVAC_HEAT_COOL:
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      case LENNOX_HVAC_OFF:
      default:
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  /**
   * Set target heating/cooling state
   */
  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    let mode: string;

    switch (value) {
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        mode = LENNOX_HVAC_HEAT;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        mode = LENNOX_HVAC_COOL;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        mode = LENNOX_HVAC_HEAT_COOL;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
      default:
        mode = LENNOX_HVAC_OFF;
        break;
    }

    try {
      await this.zone.setHVACMode(mode);
      this.platform.log.debug(`Set HVAC mode to ${mode} for zone ${this.zone.id}`);
    } catch (error) {
      this.platform.log.error('Failed to set HVAC mode:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get target temperature (Celsius)
   * For single-setpoint mode: returns sp
   * For dual-setpoint mode: returns hsp or csp based on mode
   */
  getTargetTemperature(): CharacteristicValue {
    // When single setpoint mode is active, use sp (single/perfect temp)
    if (this.zone.system.singleSetpointMode) {
      let temp = 21; // Default
      if (this.zone.spC !== null) {
        temp = this.zone.spC;
      } else if (this.zone.sp !== null) {
        temp = this.fToC(this.zone.sp);
      }
      return Math.max(10, Math.min(35, temp));
    }
    
    // Dual setpoint mode - return based on current mode
    let temp = 21; // Default
    switch (this.zone.systemMode) {
      case LENNOX_HVAC_HEAT:
      case LENNOX_HVAC_EMERGENCY_HEAT:
        if (this.zone.hspC !== null) temp = this.zone.hspC;
        else if (this.zone.hsp !== null) temp = this.fToC(this.zone.hsp);
        break;
      case LENNOX_HVAC_COOL:
        if (this.zone.cspC !== null) temp = this.zone.cspC;
        else if (this.zone.csp !== null) temp = this.fToC(this.zone.csp);
        break;
      case LENNOX_HVAC_HEAT_COOL:
        // In auto mode (non-SSP), return csp as a reasonable default
        if (this.zone.cspC !== null) temp = this.zone.cspC;
        else if (this.zone.csp !== null) temp = this.fToC(this.zone.csp);
        break;
    }
    return Math.max(10, Math.min(35, temp));
  }

  /**
   * Set target temperature
   */
  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const tempC = value as number;

    try {
      if (this.zone.system.singleSetpointMode) {
        // Single setpoint mode
        await this.zone.performSetpoint({ spC: tempC });
      } else {
        // Dual setpoint mode - set based on current mode
        switch (this.zone.systemMode) {
          case LENNOX_HVAC_HEAT:
          case LENNOX_HVAC_EMERGENCY_HEAT:
            await this.zone.performSetpoint({ hspC: tempC });
            break;
          case LENNOX_HVAC_COOL:
            await this.zone.performSetpoint({ cspC: tempC });
            break;
          case LENNOX_HVAC_HEAT_COOL:
            // In auto mode, adjust both to maintain separation
            await this.zone.performSetpoint({ cspC: tempC });
            break;
        }
      }
      this.platform.log.debug(`Set target temperature to ${tempC}°C for zone ${this.zone.id}`);
    } catch (error) {
      this.platform.log.error('Failed to set target temperature:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get heating threshold temperature (Celsius)
   */
  getHeatingThreshold(): CharacteristicValue {
    let temp = 18; // Default
    if (this.zone.hspC !== null) {
      temp = this.zone.hspC;
    } else if (this.zone.hsp !== null) {
      temp = this.fToC(this.zone.hsp);
    }
    // Clamp to HomeKit valid range (10-35°C)
    return Math.max(10, Math.min(35, temp));
  }

  /**
   * Set heating threshold temperature
   */
  async setHeatingThreshold(value: CharacteristicValue): Promise<void> {
    const tempC = value as number;

    try {
      await this.zone.performSetpoint({ hspC: tempC });
      this.platform.log.debug(`Set heating threshold to ${tempC}°C for zone ${this.zone.id}`);
    } catch (error) {
      this.platform.log.error('Failed to set heating threshold:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get cooling threshold temperature (Celsius)
   */
  getCoolingThreshold(): CharacteristicValue {
    let temp = 24; // Default
    if (this.zone.cspC !== null) {
      temp = this.zone.cspC;
    } else if (this.zone.csp !== null) {
      temp = this.fToC(this.zone.csp);
    }
    // Clamp to HomeKit valid range (10-35°C)
    return Math.max(10, Math.min(35, temp));
  }

  /**
   * Set cooling threshold temperature
   */
  async setCoolingThreshold(value: CharacteristicValue): Promise<void> {
    const tempC = value as number;

    try {
      await this.zone.performSetpoint({ cspC: tempC });
      this.platform.log.debug(`Set cooling threshold to ${tempC}°C for zone ${this.zone.id}`);
    } catch (error) {
      this.platform.log.error('Failed to set cooling threshold:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get current humidity
   */
  getCurrentHumidity(): CharacteristicValue {
    return this.zone.humidity ?? 50;
  }

  /**
   * Get temperature display units
   */
  getDisplayUnits(): CharacteristicValue {
    if (this.zone.system.temperatureUnit === 'C') {
      return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
    }
    return this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }

  /**
   * Set temperature display units (no-op, controlled by thermostat)
   */
  async setDisplayUnits(value: CharacteristicValue): Promise<void> {
    // Display units are controlled by the thermostat itself
    this.platform.log.debug('Temperature display units are controlled by the thermostat');
  }
}

