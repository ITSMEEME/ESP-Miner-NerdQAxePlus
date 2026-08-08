#include <algorithm>
#include <math.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "mining.h"
#include "periodic.hpp"

#include "boards/board.h"
#include "fan_controller.h"
#include "global_state.h"
#include "influx_task.h"
#include "nvs_config.h"
#include "serial.h"

#define POLL_RATE 2000

static const char *TAG = "power_management";

// #define MEASURE_LOOP_TIME

PowerManagementTask::PowerManagementTask()
{
    m_mutex = xSemaphoreCreateRecursiveMutex();
}

void PowerManagementTask::taskWrapper(void *pvParameters)
{
    PowerManagementTask *powerManagementTask = (PowerManagementTask *) pvParameters;
    powerManagementTask->task();
}

void PowerManagementTask::restart()
{
    ESP_LOGW(TAG, "Shutdown requested ...");
    // stops the main task
    lock();

    ESP_LOGW(TAG, "HW lock acquired!");
    // shutdown asics and LDOs before reset
    shutdown();

    ESP_LOGW(TAG, "restart");
    esp_restart();

    // unreachable
    unlock();
}

void PowerManagementTask::shutdown()
{
    lock();
    if (m_board) {
        m_shutdown = true;
        m_board->shutdown();
    }
    unlock();
}

uint16_t PowerManagementTask::getFanRPM(int channel)
{
    return m_fanController.getRPM(channel);
}

void PowerManagementTask::checkCoreVoltageChanged()
{
    static uint16_t last_core_voltage = 0;

    uint16_t core_voltage = m_board->getAsicVoltageMillis();

    if (core_voltage != last_core_voltage) {
        ESP_LOGI(TAG, "setting new vcore voltage to %umV", core_voltage);
        m_board->setVoltage((float) core_voltage / 1000.0);
        last_core_voltage = core_voltage;
        m_active_voltage = core_voltage;
    }
}

void PowerManagementTask::checkAsicFrequencyChanged()
{
    static uint16_t last_asic_frequency = 0;

    uint16_t asic_frequency = m_board->getAsicFrequency();

    if (asic_frequency != last_asic_frequency) {
        ESP_LOGI(TAG, "setting new asic frequency to %uMHz", asic_frequency);
        if (m_board->setAsicFrequency((float) asic_frequency)) {
            ESP_LOGI(TAG, "successfully set asic frequency to %uMHz", asic_frequency);
            last_asic_frequency = asic_frequency;
            m_active_frequency = asic_frequency;
            m_throttle_ceiling = 0;
        } else {
            ESP_LOGE(TAG, "failed to set asic frequency to %uMHz (pll setting not found or driver error)", asic_frequency);
            last_asic_frequency = asic_frequency;
            m_throttle_ceiling = 0;
        }
    }
}

void PowerManagementTask::checkVrFrequencyChanged()
{
    static uint32_t lastVrFrequency = 0;

    uint32_t vrFrequency = m_board->getVrFrequency();
    if (vrFrequency != lastVrFrequency) {
        m_board->setVrFrequency(vrFrequency);
        ESP_LOGI(TAG, "setting version rolling frequency to %luHz", vrFrequency);
        lastVrFrequency = vrFrequency;
    }
}


void PowerManagementTask::logChipTemps()
{
    size_t offset = 0;

    // no chip temp to report
    if (m_board->getMaxChipTemp() == 0.0f) {
        return;
    }

    // Iterate through each ASIC and append its count to the log message
    for (int i = 0; i < m_board->getAsicCount(); i++) {
        offset += snprintf(m_logBuffer + offset, sizeof(m_logBuffer) - offset, "%.2f°C / ", m_board->getChipTemp(i));
    }
    if (offset >= 2) {
        m_logBuffer[offset - 2] = 0; // remove trailing slash
    }

    ESP_LOGI(TAG, "chip temperatures: %s", m_logBuffer);
}

void PowerManagementTask::create_job_timer(TimerHandle_t xTimer)
{
    // Retrieve 'this' pointer from timer ID
    PowerManagementTask *task = (PowerManagementTask *) pvTimerGetTimerID(xTimer);
    if (!task) {
        return;
    }
    task->trigger();
}

void PowerManagementTask::trigger()
{
    pthread_mutex_lock(&m_loop_mutex);
    pthread_cond_signal(&m_loop_cond);
    pthread_mutex_unlock(&m_loop_mutex);
}

bool PowerManagementTask::startTimer()
{
    // Create the timer
    m_timer = xTimerCreate(TAG, pdMS_TO_TICKS(POLL_RATE), pdTRUE, (void *) this, create_job_timer);

    if (m_timer == NULL) {
        ESP_LOGE(TAG, "Failed to create timer");
        return false;
    }

    // Start the timer
    if (xTimerStart(m_timer, 0) != pdPASS) {
        ESP_LOGE(TAG, "Failed to start timer");
        return false;
    }
    return true;
}

void PowerManagementTask::readAndPublishPowerTelemetry()
{
    if (!m_board->isBuckInitialized()) {
        return;
    }

    static Periodic every_15s(sec_to_us(15), /*start_immediately=*/true);

    // request buck telemetry
    if (every_15s.due()) {
        m_board->requestBuckTelemtry();
    }

    float vin = m_board->getVin();
    float iin = m_board->getIin();
    float pin = m_board->getPin();
    float pout = m_board->getPout();
    float vout = m_board->getVout();
    float iout = m_board->getIout();

    m_vrTemp = m_board->getVRTemp();
    m_vrTempInt = m_board->getVRTempInt();

    ESP_LOGI(TAG, "vin: %.2f, iin: %.2f, pin: %.2f, vout: %.2f, iout: %.2f, pout: %.2f, vr-temp: %.2f, vr-temp-int: %.2f", vin, iin,
             pin, vout, iout, pout, m_vrTemp, m_vrTempInt);

    influx_task_set_pwr(vin, iin, pin, vout, iout, pout);

    // currently only implemented for boards with TPS536x7
    uint32_t status = 0;
    Board::Error error = m_board->getFault(&status);
    if (error != Board::Error::NONE) {
        SYSTEM_MODULE.setBoardError(error, status);
        m_board->setVoltage(0.0);
    }

    m_voltage = vin * 1000.0;
    m_current = iin * 1000.0;
    m_power = pin;
}

void PowerManagementTask::applyAsicSettings()
{
    // not available when asics are shutdown
    if (m_shutdown) {
        return;
    }

    // don't change frequency or voltage if
    // asics haven't been initialized
    if (!m_board->isInitialized()) {
        return;
    }

    // check if asic voltage changed
    checkCoreVoltageChanged();

    // check if asic frequency changed
    checkAsicFrequencyChanged();

    // check if version rolling frequency changed
    checkVrFrequencyChanged();
}

void PowerManagementTask::requestChipTemps()
{
    // temperature measurements don't work before ASICs
    // are initialized
    if (!m_board->isInitialized()) {
        return;
    }

    m_board->requestChipTemps();
}

void PowerManagementTask::task()
{
    m_board = SYSTEM_MODULE.getBoard();

    // use manual invert polarity setting
    bool invert = m_board->isInvertFanPolarityEnabled();

    m_board->setFanPolarity(invert);

    m_fanController.init(m_board, POLL_RATE);

    vTaskDelay(pdMS_TO_TICKS(1000));
    startTimer();

    uint64_t last_time = esp_timer_get_time();
    while (1) {
        pthread_mutex_lock(&m_loop_mutex);
        pthread_cond_wait(&m_loop_cond, &m_loop_mutex); // Wait for the timer
        pthread_mutex_unlock(&m_loop_mutex);

        uint64_t start = esp_timer_get_time();
        lock();

        applyAsicSettings();

        // request chip temps
        requestChipTemps();

        logChipTemps();

        readAndPublishPowerTelemetry();

        // collect temperatures
        // get the max of all asic measuring temp sensors
        float tmp1075Max = 0.0f;
        for (int i = 0; i < m_board->getNumTempSensors(); i++) {
            float tmp = m_board->getTemperature(i);
            if (tmp) {
                ESP_LOGI(TAG, "Temperature %d: %.2f C", i, tmp);
            }
            tmp1075Max = std::max(tmp1075Max, tmp);
        }

        // get max temp of all chips
        // returns 0 if not available on the hardware
        float intChipTempMax = m_board->getMaxChipTemp();

#ifdef NERDQAXEPLUS
        // NQ+ needs special care - the reading of chip internal temp sensors is way
        // too slow for the PID, so we need to stay compatible.
        // we use the max temp of board temp sensors and ASICs
        // note: m_chipTempMax is not mutexed, single assignment required
        m_chipTempMax = std::max(tmp1075Max, intChipTempMax);
#else
        // on other devices that have the TMUX like the QX we only use
        // the chip temps for the PID
        // note: m_chipTempMax is not mutexed, single assignment required
        m_chipTempMax = intChipTempMax ? intChipTempMax : tmp1075Max;
#endif

        influx_task_set_temperature(m_chipTempMax, m_vrTemp);

        // thermal throttling logic
        if (m_board->isInitialized()) {
            bool auto_throttle = Config::isAutoThrottleEnabled();
            uint16_t throttle_temp = Config::getThrottleTemp();
            uint16_t base_freq = m_board->getAsicFrequency();
            uint64_t current_time = esp_timer_get_time();

            if (!auto_throttle || m_chipTempMax == 0.0f) {
                // reset ceiling when throttle is disabled
                m_throttle_ceiling = 0;
                if (m_active_frequency != base_freq && m_active_frequency != 0) {
                    ESP_LOGI(TAG, "auto-throttle disabled, restoring base frequency %uMHz", base_freq);
                    if (m_board->setAsicFrequency((float) base_freq)) {
                        m_active_frequency = base_freq;
                        // Restore base voltage when throttle is disabled
                        uint16_t base_voltage = Config::getAsicVoltage(1200);
                        m_board->setVoltage((float) base_voltage / 1000.0);
                        m_active_voltage = base_voltage;
                        ESP_LOGI(TAG, "auto-throttle disabled, restoring base voltage %umV", base_voltage);
                    } else {
                        ESP_LOGE(TAG, "failed to restore base frequency %uMHz", base_freq);
                    }
                }
            } else {
                // effective ceiling: never exceed the frequency that was active
                // when throttling first kicked in, even if user raises base_freq
                uint16_t effective_ceiling = m_throttle_ceiling
                    ? std::min(base_freq, m_throttle_ceiling)
                    : base_freq;

                uint64_t cooldown_us = 90000000ULL; // 90 seconds
                if (m_last_throttle_change == 0 || (current_time - m_last_throttle_change) >= cooldown_us) {
                    if (m_chipTempMax > throttle_temp) {
                        if (m_active_frequency > 500) {
                            // Initialize active voltage on first use (safety: if checkCoreVoltageChanged hasn't run yet)
                            if (m_active_voltage == 0) {
                                m_active_voltage = Config::getAsicVoltage(1200);
                            }
                            // snapshot ceiling on first throttle-down
                            if (m_throttle_ceiling == 0) {
                                m_throttle_ceiling = base_freq;
                                ESP_LOGI(TAG, "Throttle ceiling locked at %uMHz", m_throttle_ceiling);
                            }
                            uint16_t next_freq = m_active_frequency - 5;
                            if (next_freq < 500) next_freq = 500;

                            uint16_t base_voltage = Config::getAsicVoltage(1200);
                            uint16_t next_volt = m_active_voltage >= 1010 ? m_active_voltage - 10 : 1000;
                            if (next_volt > base_voltage) next_volt = base_voltage;
                            if (next_volt > 1200) next_volt = 1200;

                            ESP_LOGW(TAG, "Thermal throttle active! Temp: %.2f°C limit: %u°C. Lowering freq to %uMHz (ceiling: %uMHz), volt to %umV", m_chipTempMax, throttle_temp, next_freq, m_throttle_ceiling, next_volt);
                            if (m_board->setAsicFrequency((float) next_freq)) {
                                m_board->setVoltage((float) next_volt / 1000.0);
                                m_active_frequency = next_freq;
                                m_active_voltage = next_volt;
                                m_last_throttle_change = current_time;
                            } else {
                                ESP_LOGE(TAG, "failed to apply thermal throttle frequency step to %uMHz", next_freq);
                            }
                        }
                    } else if (m_chipTempMax < (throttle_temp - 5) && m_active_frequency < effective_ceiling) {
                        uint16_t next_freq = m_active_frequency + 5;
                        if (next_freq > effective_ceiling) next_freq = effective_ceiling;

                        uint16_t base_voltage = Config::getAsicVoltage(1200);
                        uint16_t next_volt = m_active_voltage + 10;
                        if (next_volt > base_voltage) next_volt = base_voltage;
                        if (next_volt > 1200 && next_freq < effective_ceiling) next_volt = 1200;

                        ESP_LOGI(TAG, "Cooling down. Temp: %.2f°C limit: %u°C. Raising freq to %uMHz (ceiling: %uMHz), volt to %umV", m_chipTempMax, throttle_temp - 5, next_freq, m_throttle_ceiling, next_volt);
                        if (m_board->setAsicFrequency((float) next_freq)) {
                            m_board->setVoltage((float) next_volt / 1000.0);
                            m_active_frequency = next_freq;
                            m_active_voltage = next_volt;
                            m_last_throttle_change = current_time;
                            // reset ceiling when fully recovered
                            if (m_active_frequency >= effective_ceiling) {
                                ESP_LOGI(TAG, "Throttle fully recovered, ceiling released");
                                m_throttle_ceiling = 0;
                                m_board->setVoltage((float) base_voltage / 1000.0);
                                m_active_voltage = base_voltage;
                            }
                        } else {
                            ESP_LOGE(TAG, "failed to apply frequency ramp-up step to %uMHz", next_freq);
                        }
                    } else if (m_active_frequency > effective_ceiling) {
                        ESP_LOGI(TAG, "Active frequency %uMHz is higher than effective ceiling %uMHz, restoring ceiling", m_active_frequency, effective_ceiling);
                        if (m_board->setAsicFrequency((float) effective_ceiling)) {
                            m_active_frequency = effective_ceiling;
                            m_last_throttle_change = current_time;
                        } else {
                            ESP_LOGE(TAG, "failed to restore frequency to effective ceiling %uMHz", effective_ceiling);
                        }
                    } else if (m_active_frequency < effective_ceiling && (current_time - m_last_throttle_change) >= 120000000ULL) {
                        // Stabilize Hash Rate Check
                        float real_ghs = HASHRATE_MONITOR.getHashrate();
                        uint16_t small_cores = m_board->getAsics() ? m_board->getAsics()->getSmallCoreCount() : 0;
                        float expected_ghs = ((float) m_active_frequency * m_board->getAsicCount() * small_cores) / 1000.0f;
                        
                        if (expected_ghs > 0 && real_ghs < expected_ghs * 0.95f) {
                            uint16_t base_voltage = Config::getAsicVoltage(1200);
                            uint16_t next_volt = m_active_voltage + 5;
                            if (next_volt > base_voltage) next_volt = base_voltage;
                            if (next_volt > 1200) next_volt = 1200;

                            if (next_volt > m_active_voltage) {
                                ESP_LOGW(TAG, "Hashrate too low (%.2f < %.2f GH/s). Raising voltage to %umV to stabilize", real_ghs, expected_ghs, next_volt);
                                m_board->setVoltage((float) next_volt / 1000.0);
                                m_active_voltage = next_volt;
                                m_last_throttle_change = current_time; // Reset timer so we don't spam
                            }
                        }
                    }
                }
            }
        }

        // Run fan controller (reads RPM, drives fans, updates overheat flags)
        m_fanController.update(m_chipTempMax, m_vrTemp);

        // Shutdown if any fan channel reports overheat
        if (m_fanController.isOverheated(0) || m_fanController.isOverheated(1)) {
            uint32_t status = ((uint32_t) m_chipTempMax << 24) | ((uint32_t) m_fanController.getOverheatTemp(0) << 16) |
                              ((uint32_t) m_vrTemp << 8) | ((uint32_t) m_fanController.getOverheatTemp(1));

            // over temperature — ASIC takes priority over VReg-only
            Board::Error overheatErr = Board::Error::VREG_TEMP_FAULT;
            if (m_fanController.isOverheated(0)) overheatErr = Board::Error::TEMP_FAULT;
            SYSTEM_MODULE.setBoardError(overheatErr, status);

            // disables the buck
            m_board->setVoltage(0.0);
            ESP_LOGE(TAG, "System overheated (chip=%.1f°C/thresh=%d°C vr=%.2f°C/thresh=%d°C) - Shutting down asic voltage",
                     m_chipTempMax, m_fanController.getOverheatTemp(0), m_vrTemp, m_fanController.getOverheatTemp(1));
        }
        influx_set_fan(m_fanController.getSpeedPerc(0), (float) m_fanController.getRPM(0), m_fanController.getSpeedPerc(1),
                       (float) m_fanController.getRPM(1));
        unlock();
#ifdef MEASURE_LOOP_TIME
        // checks if loop takes too much time
        uint64_t end = esp_timer_get_time();
        uint64_t duration = (end - start) / 1000llu;
        uint64_t interval = (start - last_time) / 1000llu;
        if (duration > POLL_RATE) {
            ESP_LOGE(TAG, "loop taking more then %dms (%llums, interval: %llu)", POLL_RATE, duration, interval);
        }
        last_time = start;
#endif
    }
}

uint16_t PowerManagementTask::getActiveFrequency()
{
    return m_active_frequency;
}

uint16_t PowerManagementTask::getActiveVoltage()
{
    return m_active_voltage;
}

bool PowerManagementTask::isThrottled()
{
    if (!m_board) return false;
    uint16_t base_freq = m_board->getAsicFrequency();
    return Config::isAutoThrottleEnabled() && m_active_frequency > 0 && m_active_frequency < base_freq;
}
