import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { LennoxS30Platform } from '../platform';
import { LennoxSystem } from 'lennoxapi';

/**
 * AllergenSwitchAccessory - Exposes allergen defender control as a HomeKit Switch
 */
export class AllergenSwitchAccessory {
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

    // Get or create switch service
    this.service = this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    // Set display name
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Allergen Defender');

    // On/Off characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    // Register callback for push updates
    this.system.registerOnUpdateCallback(() => {
      this.updateCharacteristics();
    }, ['allergenDefender']);
  }

  /**
   * Update characteristics from system state (called via callback)
   */
  private updateCharacteristics(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.On,
      this.getOn(),
    );
  }

  /**
   * Get current allergen defender state
   */
  getOn(): CharacteristicValue {
    return this.system.allergenDefender === true;
  }

  /**
   * Set allergen defender state
   */
  async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;

    try {
      if (on) {
        await this.system.allergenDefenderOn();
      } else {
        await this.system.allergenDefenderOff();
      }
      this.platform.log.debug(`Set allergen defender to ${on ? 'ON' : 'OFF'}`);
    } catch (error) {
      this.platform.log.error('Failed to set allergen defender:', (error as Error).message);
      throw error;
    }
  }
}

