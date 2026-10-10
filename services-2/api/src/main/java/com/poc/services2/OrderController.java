package com.poc.services2;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
public class OrderController {

    @PostMapping("/checkout")
    public String checkout() {
        throw new RuntimeException("Simulated checkout error for Sentry!");
    }
}
