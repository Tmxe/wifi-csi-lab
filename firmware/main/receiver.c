#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "bootloader_random.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "nvs_flash.h"

#if !CONFIG_IDF_TARGET_ESP32
#error "Build for the original ESP32 target."
#endif

#define CSI_BYTES 128
#define PROBE_PORT 4210
#define MIN_SAMPLE_MS 50

typedef struct {
    uint64_t time_ms;
    int8_t rssi;
    int8_t iq[CSI_BYTES];
} sample_t;

static QueueHandle_t samples;
static portMUX_TYPE peer_lock = portMUX_INITIALIZER_UNLOCKED;
static uint8_t peer[6];
static bool peer_connected;
static char lab_password[13];

static void on_peer(void *arg, esp_event_base_t base, int32_t event, void *data)
{
    (void)arg;
    (void)base;
    portENTER_CRITICAL(&peer_lock);
    if (event == WIFI_EVENT_AP_STACONNECTED) {
        const wifi_event_ap_staconnected_t *connection = data;
        memcpy(peer, connection->mac, sizeof(peer));
        peer_connected = true;
    } else {
        peer_connected = false;
    }
    portEXIT_CRITICAL(&peer_lock);
}

static void on_csi(void *arg, wifi_csi_info_t *info)
{
    (void)arg;
    static uint64_t last_sample;
    if (info == NULL || info->buf == NULL || info->len != CSI_BYTES || info->rx_ctrl.cwb != 0) {
        return;
    }

    portENTER_CRITICAL(&peer_lock);
    const bool from_peer = peer_connected && memcmp(info->mac, peer, sizeof(peer)) == 0;
    portEXIT_CRITICAL(&peer_lock);
    const uint64_t now = (uint64_t)(esp_timer_get_time() / 1000);
    if (!from_peer || now - last_sample < MIN_SAMPLE_MS) {
        return;
    }

    sample_t sample = { .time_ms = now, .rssi = info->rx_ctrl.rssi };
    memcpy(sample.iq, info->buf, sizeof(sample.iq));
    if (info->first_word_invalid) {
        memset(sample.iq, 0, 4);
    }
    last_sample = now;
    xQueueSend(samples, &sample, 0);
}

static void write_serial(void *arg)
{
    (void)arg;
    char line[720];
    sample_t sample;
    int64_t announce_at = 0;
    for (;;) {
        const int64_t now = esp_timer_get_time();
        if (now >= announce_at) {
            printf("LAB1,%s\n", lab_password);
            announce_at = now + 3000000;
        }
        if (xQueueReceive(samples, &sample, pdMS_TO_TICKS(200)) != pdTRUE) {
            continue;
        }
        size_t offset = (size_t)snprintf(line, sizeof(line), "CSI1,%" PRIu64 ",%d", sample.time_ms, sample.rssi);
        for (size_t i = 0; i < CSI_BYTES; i++) {
            offset += (size_t)snprintf(line + offset, sizeof(line) - offset, ",%d", sample.iq[i]);
        }
        puts(line);
    }
}

static void receive_probes(void *arg)
{
    (void)arg;
    const int listener = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (listener < 0) {
        puts("ERR1,UDP listener unavailable");
        vTaskDelete(NULL);
        return;
    }
    const struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(PROBE_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(listener, (const struct sockaddr *)&address, sizeof(address)) < 0) {
        close(listener);
        puts("ERR1,UDP listener unavailable");
        vTaskDelete(NULL);
        return;
    }
    char payload[128];
    for (;;) {
        // Read and discard. The Wi-Fi callback handles CSI independently of packet payloads.
        if (recv(listener, payload, sizeof(payload), 0) < 0 && errno != EINTR) {
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
}

void app_main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    ESP_ERROR_CHECK(nvs_flash_init());
    uint8_t random[6];
    bootloader_random_enable();
    esp_fill_random(random, sizeof(random));
    bootloader_random_disable();
    for (size_t i = 0; i < sizeof(random); i++) {
        snprintf(lab_password + 2 * i, 3, "%02x", (unsigned)random[i]);
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_netif_create_default_wifi_ap() ? ESP_OK : ESP_ERR_NO_MEM);
    samples = xQueueCreate(16, sizeof(sample_t));
    ESP_ERROR_CHECK(samples ? ESP_OK : ESP_ERR_NO_MEM);

    wifi_init_config_t driver = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&driver));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_STACONNECTED, on_peer, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_STADISCONNECTED, on_peer, NULL));

    wifi_config_t network = {
        .ap = {
            .ssid = "CSI-Lab",
            .channel = 6,
            .authmode = WIFI_AUTH_WPA2_PSK,
            .max_connection = 1,
        },
    };
    memcpy(network.ap.password, lab_password, sizeof(lab_password));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &network));
    ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW_HT20));
    ESP_ERROR_CHECK(esp_wifi_start());
    const wifi_csi_config_t csi = {
        .lltf_en = true,
        .htltf_en = false,
        .stbc_htltf2_en = false,
        .ltf_merge_en = false,
        .channel_filter_en = false,
        .manu_scale = false,
    };
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(on_csi, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));
    ESP_ERROR_CHECK(xTaskCreate(write_serial, "csi_uart", 4096, NULL, 3, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(xTaskCreate(receive_probes, "probe_udp", 3072, NULL, 3, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
}
