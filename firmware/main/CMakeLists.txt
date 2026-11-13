idf_component_register(SRCS "receiver.c"
                       PRIV_REQUIRES bootloader_support esp_event esp_netif esp_timer esp_wifi esp_hw_support lwip nvs_flash)
