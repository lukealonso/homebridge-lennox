import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { LennoxS30Platform } from '../platform';
import { LennoxSystem } from 'lennoxapi';

/**
 * OutdoorTemperatureSensor - Exposes outdoor temperature as a HomeKit Temperature Sensor
 */
export class OutdoorTemperatureSensor {
  private service: Service;

  constructor(
    private readonly platform: LennoxS30Platform,
    private readonly accessory: PlatformAccessory,
    private readonly system: LennoxSystem,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Lennox')
      .setCharacteristic(this.platform.Characteristic.Model, this.system.productType ?? 'S30/S40')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.system.serialNumber ?? 'Unknown');

    // Get or create temperature sensor service
    this.service = this.accessory.getService(this.platform.Service.TemperatureSensor) ||
      this.accessory.addService(this.platform.Service.TemperatureSensor);

    // Set display name
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Outdoor Temperature');

    // Current temperature (read-only)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // Register callback for push updates
    this.system.registerOnUpdateCallback(() => {
      this.updateCharacteristics();
    }, ['outdoorTemperature', 'outdoorTemperatureC']);
  }

  /**
   * Update characteristics from system state (called via callback)
   */
  private updateCharacteristics(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.getCurrentTemperature(),
    );
  }

  /**
   * Convert Fahrenheit to Celsius
   */
  private fToC(f: number): number {
    return Math.round((f - 32) * (5 / 9) * 2) / 2;
  }

  /**
   * Get current outdoor temperature (Celsius)
   */
  getCurrentTemperature(): CharacteristicValue {
    if (this.system.outdoorTemperatureC !== null) {
      return this.system.outdoorTemperatureC;
    }
    if (this.system.outdoorTemperature !== null) {
      return this.fToC(this.system.outdoorTemperature);
    }
    return 20; // Default
  }
}

