import { PlatformConfig } from 'homebridge';

/**
 * Optional accessories configuration
 */
export interface AccessoriesConfig {
  awaySwitch?: boolean;
  ventilationSwitch?: boolean;
  allergenSwitch?: boolean;
  outdoorTemperature?: boolean;
}

/**
 * Single thermostat configuration
 */
export interface ThermostatConfig {
  ipAddress: string;
}

/**
 * Plugin configuration
 */
export interface LennoxS30Config extends PlatformConfig {
  thermostats?: ThermostatConfig[];
  pollInterval?: number;
  accessories?: AccessoriesConfig;
}

